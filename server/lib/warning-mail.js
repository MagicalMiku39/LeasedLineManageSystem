import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { agentMail } from './agent-mail.js';

const levelLabels = { green: '绿色（0–89 天）', yellow: '黄色（90–149 天）', red: '红色（150–179 天）', cancel: '待销户（满 180 天）' };
export const managerKey = (row) => row.manager_job_no?.trim() ? `job:${row.manager_job_no.trim()}` : `name:${row.manager_name?.trim() || ''}`;

export function createWarningMailRouter({ db, leasedLineSource, currentUser, stoppedDays, warningLevel, mail = agentMail }) {
  const router = Router();
  db.exec(`CREATE TABLE IF NOT EXISTS warning_mail_contact (
    manager_key TEXT PRIMARY KEY, email TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS warning_mail_delivery (
    id TEXT PRIMARY KEY, line_id INTEGER NOT NULL, actor TEXT NOT NULL,
    fingerprint TEXT NOT NULL, report_json TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, sent_at TEXT, error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_warning_mail_fingerprint ON warning_mail_delivery(fingerprint, status);
  CREATE INDEX IF NOT EXISTS idx_warning_mail_line ON warning_mail_delivery(line_id, created_at);`);

  function contacts() {
    const saved = new Map(db.prepare('SELECT manager_key, email FROM warning_mail_contact').all().map((row) => [row.manager_key, row.email]));
    const managers = new Map();
    for (const row of db.prepare("SELECT DISTINCT manager_job_no, manager_name FROM leased_line WHERE COALESCE(manager_name, '') <> '' ORDER BY manager_name").all()) {
      const key = managerKey(row);
      managers.set(key, { key, name: row.manager_name, jobNo: row.manager_job_no || '', email: saved.get(key) || '' });
    }
    return [...managers.values()];
  }
  function reportFor(id, asOf, kpiMode) {
    if (!Number.isSafeInteger(id) || id < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(String(asOf)) || stoppedDays(asOf, asOf) !== 0) throw new Error('专线或统计日期不正确');
    const row = db.prepare(`SELECT * FROM ${leasedLineSource({ kpiMode })} WHERE id = ?`).get(id);
    if (!row || row.product_status_name !== '停机' || !(row.total_arrears > 0)) throw new Error('该专线已不符合欠费停机条件，请刷新');
    const days = stoppedDays(row.status_time, asOf);
    if (days === null) throw new Error('状态时间缺失、无效或晚于统计日期');
    if (!row.manager_name?.trim()) throw new Error('该专线缺少客户经理，无法确定收件人');
    const contact = db.prepare('SELECT email FROM warning_mail_contact WHERE manager_key = ?').get(managerKey(row));
    if (!contact?.email) throw new Error(`请先在客户经理邮箱设置中填写 ${row.manager_name} 的邮箱`);
    const report = {
      lineId: id, asOf, kpiMode: String(kpiMode ?? '1'), recipient: contact.email, cc: mail.defaultCc(), manager: row.manager_name,
      subject: `欠费停机预警｜${row.group_name || row.group_code || '集团'}｜${asOf}`,
      body: `${row.manager_name}，您好：\n\n以下专线处于欠费停机状态，请跟进处理。\n\n统计日期：${asOf}\n集团编码：${row.group_code || '-'}\n集团名称：${row.group_name || '-'}\n集团产品编码：${row.group_product_code || '-'}\n产品编码：${row.product_code || '-'}\n产品名称：${row.product_name || '-'}\n产品账户：${row.group_product_account_id || '-'}\n客户经理：${row.manager_name}\n客户经理工号：${row.manager_job_no || '-'}\n停机日期：${row.status_time.slice(0, 10)}\n停机时长：${days} 天\n总欠费：${Number(row.total_arrears).toFixed(2)} 元\n预警等级：${levelLabels[warningLevel(days)]}\n\n${days >= 180 ? '该专线欠费停机已满 180 天，请核实并按业务流程办理销户。' : '请核实欠费原因，联系客户处理欠费，并跟进专线恢复情况。'}\n\n停机天数按统计日期与状态日期的自然日差计算。`
    };
    return { report, fingerprint: createHash('sha256').update(JSON.stringify(report)).digest('hex') };
  }
  router.get('/mail/contacts', (_req, res) => res.json(contacts()));
  router.put('/mail/contacts', (req, res) => {
    const { key, email } = req.body || {};
    if (typeof key !== 'string' || !contacts().some((item) => item.key === key) || typeof email !== 'string' || email.length > 254 || (email && !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(email))) return res.status(400).json({ error: '请选择客户经理，并填写有效的单个邮箱地址' });
    db.prepare(`INSERT INTO warning_mail_contact VALUES (?, ?, ?, ?) ON CONFLICT(manager_key) DO UPDATE SET
      email=excluded.email, updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(key, email, currentUser(req)?.username || '', new Date().toISOString());
    res.json({ key, email });
  });
  router.get('/mail/status', async (_req, res) => res.json(await mail.status()));
  router.get('/:id/mail-history', (req, res) => {
    const rows = db.prepare('SELECT id, status, created_at, sent_at, error, report_json FROM warning_mail_delivery WHERE line_id = ? ORDER BY created_at DESC LIMIT 10').all(Number(req.params.id));
    res.json(rows.map(({ report_json, ...row }) => ({ ...row, recipient: JSON.parse(report_json).recipient })));
  });
  router.post('/:id/reminder/preview', (req, res) => {
    try {
      const { report, fingerprint } = reportFor(Number(req.params.id), req.body?.asOf, req.body?.kpiMode);
      const id = randomUUID();
      db.prepare("INSERT INTO warning_mail_delivery (id,line_id,actor,fingerprint,report_json,status,created_at) VALUES (?,?,?,?,?,'preview',?)")
        .run(id, report.lineId, currentUser(req)?.username || '', fingerprint, JSON.stringify(report), new Date().toISOString());
      res.json({ id, ...report });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.post('/:id/reminder', async (req, res) => {
    const delivery = db.prepare('SELECT * FROM warning_mail_delivery WHERE id = ? AND line_id = ? AND actor = ?')
      .get(String(req.body?.previewId || ''), Number(req.params.id), currentUser(req)?.username || '');
    if (!delivery) return res.status(400).json({ error: '报告预览不存在，请重新预览' });
    const report = JSON.parse(delivery.report_json);
    if (delivery.status === 'queued') return res.json({ queued: true, recipient: report.recipient, sentAt: delivery.sent_at });
    if (delivery.status !== 'preview') return res.status(409).json({ error: '该发送请求已处理或状态待核实，请查看发送记录' });
    if (Date.now() - Date.parse(delivery.created_at) > 15 * 60 * 1000) return res.status(409).json({ error: '报告预览已过期，请重新预览' });
    try {
      if (reportFor(report.lineId, report.asOf, report.kpiMode).fingerprint !== delivery.fingerprint) return res.status(409).json({ error: '专线或邮箱已变更，请重新预览报告' });
    } catch (error) { return res.status(409).json({ error: error.message }); }
    db.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = db.prepare("SELECT id FROM warning_mail_delivery WHERE fingerprint = ? AND status IN ('sending','queued','unknown')").get(delivery.fingerprint);
      if (duplicate) { db.exec('ROLLBACK'); return res.status(409).json({ error: '相同报告已提交或发送状态待核实，请查看发送记录，避免重复提醒' }); }
      const changed = db.prepare("UPDATE warning_mail_delivery SET status='sending' WHERE id=? AND status='preview'").run(delivery.id);
      db.exec('COMMIT');
      if (!changed.changes) return res.status(409).json({ error: '报告正在发送，请勿重复点击' });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    try {
      const result = await mail.send(report);
      if (result?.queued !== true) throw new Error('邮箱未确认接收该报告');
    } catch (error) {
      const status = error.uncertain === false ? 'failed' : 'unknown';
      db.prepare('UPDATE warning_mail_delivery SET status=?, error=? WHERE id=?').run(status, error.message, delivery.id);
      return res.status(502).json({ error: status === 'unknown' ? `${error.message}；发送状态待核实，请先检查邮箱管理端，不要重复发送` : error.message, status });
    }
    const sentAt = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE warning_mail_delivery SET status='queued', sent_at=? WHERE id=?").run(sentAt, delivery.id);
      db.prepare(`INSERT INTO line_warning_mark VALUES (?, 'remind', ?, ?) ON CONFLICT(line_id) DO UPDATE SET
        mark='remind', updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(report.lineId, delivery.actor, sentAt);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); return res.status(500).json({ error: '邮件已提交但记录保存失败，请核实邮箱发送记录后再操作' }); }
    res.json({ queued: true, recipient: report.recipient, sentAt });
  });
  return router;
}
