import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { agentMail } from './agent-mail.js';
import { addedStatuses, cancelledStatuses } from './ledger-rules.js';
import { requestSource } from './client-cert.js';

// The fill link a summary can carry: what it opens and for how long.
const digestLinkScopes = ['ledger', 'progress'];
const digestLinkDays = 7;

const levelOrder = ['cancel', 'red', 'yellow', 'green'];
const amount = (value) => Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (value) => `${value > 0 ? '+' : ''}${value}`;

const levelLabels = { green: '绿色（0–89 天）', yellow: '黄色（90–149 天）', red: '红色（150–179 天）', cancel: '待销户（满 180 天）' };
export const managerKey = (row) => row.manager_job_no?.trim() ? `job:${row.manager_job_no.trim()}` : `name:${row.manager_name?.trim() || ''}`;

export function createWarningMailRouter({ db, leasedLineSource, currentUser, stoppedDays, warningLevel, mail = agentMail, fillLinks = null }) {
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

  // ---- 汇总发送: one message per manager with every arrears line of theirs ----
  db.exec(`CREATE TABLE IF NOT EXISTS warning_mail_digest (
    id TEXT PRIMARY KEY, manager_key TEXT NOT NULL, manager_name TEXT NOT NULL, actor TEXT NOT NULL,
    fingerprint TEXT NOT NULL, report_json TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, sent_at TEXT, error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_warning_mail_digest_fingerprint ON warning_mail_digest(fingerprint, status);`);

  // A manager's added and cancelled lines in a date range, counted like the manager page.
  function netCounts(source, manager, start, end) {
    const marks = (values) => values.map(() => '?').join(', ');
    const status = "COALESCE(product_status_name, ledger_status, '')";
    const row = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN start_time >= ? AND start_time < ? AND ${status} IN (${marks(addedStatuses)}) THEN 1 ELSE 0 END), 0) AS added,
        COALESCE(SUM(CASE WHEN status_time >= ? AND status_time < ? AND ${status} IN (${marks(cancelledStatuses)}) THEN 1 ELSE 0 END), 0) AS cancelled
      FROM ${source} WHERE manager_name = ?`).get(start, end, ...addedStatuses, start, end, ...cancelledStatuses, manager);
    return { added: row.added, cancelled: row.cancelled, net: row.added - row.cancelled };
  }

  /**
   * One report per manager who has arrears lines not marked 忽略, as of a date. A manager with no
   * address saved gets a report without a recipient, which cannot be sent. Throws when the date
   * is wrong or the default copy addresses are not configured.
   */
  function digestReports(asOf, kpiMode) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf)) || stoppedDays(asOf, asOf) !== 0) throw new Error('统计日期不正确');
    const scope = String(kpiMode ?? '1');
    const source = leasedLineSource({ kpiMode: scope });
    const cc = mail.defaultCc();
    const emails = new Map(db.prepare('SELECT manager_key, email FROM warning_mail_contact').all().map((row) => [row.manager_key, row.email]));
    const candidates = db.prepare(`SELECT l.id, l.group_code, l.group_name, l.group_product_code, l.product_code, l.product_name,
        l.group_product_account_id, l.manager_name, l.manager_job_no, l.status_time, l.total_arrears
      FROM ${source} l LEFT JOIN line_warning_mark m ON m.line_id = l.id
      WHERE l.product_status_name = '停机' AND l.total_arrears > 0 AND COALESCE(m.mark, '') <> 'ignore'`).all();
    const byManager = new Map();
    let withoutManager = 0;
    for (const row of candidates) {
      const days = stoppedDays(row.status_time, asOf);
      if (days === null) continue;
      if (!row.manager_name?.trim()) { withoutManager += 1; continue; }
      const key = managerKey(row);
      if (!byManager.has(key)) byManager.set(key, { key, manager: row.manager_name.trim(), lines: [] });
      byManager.get(key).lines.push({ ...row, days, level: warningLevel(days) });
    }
    const year = asOf.slice(0, 4);
    const month = asOf.slice(0, 7);
    const nextMonth = Number(month.slice(5)) === 12 ? `${Number(year) + 1}-01` : `${year}-${String(Number(month.slice(5)) + 1).padStart(2, '0')}`;
    const reports = [...byManager.values()].map((entry) => {
      const lines = entry.lines.sort((a, b) => b.days - a.days || b.total_arrears - a.total_arrears || a.id - b.id);
      const levels = Object.fromEntries(levelOrder.map((level) => [level, lines.filter((line) => line.level === level).length]));
      const total = lines.reduce((sum, line) => sum + Number(line.total_arrears), 0);
      const monthNet = netCounts(source, entry.manager, `${month}-01`, `${nextMonth}-01`);
      const yearNet = netCounts(source, entry.manager, `${year}-01-01`, `${Number(year) + 1}-01-01`);
      const body = [
        `${entry.manager}，您好：`,
        '',
        `截至 ${asOf}，您名下有 ${lines.length} 条专线处于欠费停机状态，欠费合计 ${amount(total)} 元，请跟进处理。`,
        `其中：${levelOrder.filter((level) => levels[level] > 0).map((level) => `${levelLabels[level]}${levels[level]} 条`).join('，')}。`,
        '',
        ...lines.flatMap((line, index) => [
          `${index + 1}. ${line.group_name || '-'}（集团编码 ${line.group_code || '-'}）`,
          `   集团产品编码 ${line.group_product_code || '-'}｜产品编码 ${line.product_code || '-'}｜${line.product_name || '-'}｜产品账户 ${line.group_product_account_id || '-'}`,
          `   停机日期 ${String(line.status_time).slice(0, 10)}，已停机 ${line.days} 天，欠费 ${amount(line.total_arrears)} 元，预警等级：${levelLabels[line.level]}`,
          ''
        ]),
        `${levels.cancel > 0 ? '欠费停机已满 180 天的专线，请核实并按业务流程办理销户；其余专线' : ''}请核实欠费原因，联系客户处理欠费，并跟进专线恢复情况。`,
        '',
        `附：您名下专线的净增情况（${scope === '0' ? '全部产品' : 'KPI 十类产品'}，新增按开始时间，销户按状态时间）`,
        `本月（${month}）：新增 ${monthNet.added} 条，销户 ${monthNet.cancelled} 条，净增 ${signed(monthNet.net)} 条`,
        `本年度（${year}）：新增 ${yearNet.added} 条，销户 ${yearNet.cancelled} 条，净增 ${signed(yearNet.net)} 条`,
        '',
        '停机天数按统计日期与状态日期的自然日差计算。已标记“忽略”的专线未列入。'
      ].join('\n');
      const report = {
        managerKey: entry.key, manager: entry.manager, asOf, kpiMode: scope, recipient: emails.get(entry.key) || '', cc,
        lineIds: lines.map((line) => line.id), lineCount: lines.length, totalArrears: total, levels,
        subject: `欠费停机预警汇总｜${entry.manager}｜${lines.length} 条｜${asOf}`,
        body
      };
      return { report, fingerprint: createHash('sha256').update(JSON.stringify(report)).digest('hex') };
    }).sort((a, b) => b.report.levels.cancel - a.report.levels.cancel || b.report.lineCount - a.report.lineCount || a.report.manager.localeCompare(b.report.manager, 'zh-CN'));
    return { reports, withoutManager };
  }

  // Building the reports sends nothing: each one waits, briefly, to be sent on its own.
  router.post('/digest/preview', (req, res) => {
    try {
      const { reports, withoutManager } = digestReports(req.body?.asOf, req.body?.kpiMode);
      const actor = currentUser(req)?.username || '';
      const now = new Date().toISOString();
      const insert = db.prepare("INSERT INTO warning_mail_digest (id, manager_key, manager_name, actor, fingerprint, report_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'preview', ?)");
      db.prepare("DELETE FROM warning_mail_digest WHERE status = 'preview' AND created_at < ?").run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      const managers = reports.map(({ report, fingerprint }) => {
        const sent = db.prepare("SELECT sent_at FROM warning_mail_digest WHERE fingerprint = ? AND status IN ('sending', 'queued', 'unknown') ORDER BY created_at DESC LIMIT 1").get(fingerprint);
        let id = null;
        if (report.recipient && !sent) {
          id = randomUUID();
          insert.run(id, report.managerKey, report.manager, actor, fingerprint, JSON.stringify(report), now);
        }
        const { lineIds, ...shown } = report;
        return { id, ...shown, problem: !report.recipient ? '未设置邮箱' : sent ? '相同内容已发送过' : '' };
      });
      res.json({ asOf: req.body.asOf, cc: reports[0]?.report.cc ?? mail.defaultCc(), withoutManager, managers,
        fillLink: fillLinks ? { days: digestLinkDays, scopes: digestLinkScopes.map((key) => fillLinks.scopeLabels[key]) } : null });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.post('/digest/:id/send', async (req, res) => {
    const delivery = db.prepare('SELECT * FROM warning_mail_digest WHERE id = ? AND actor = ?').get(String(req.params.id), currentUser(req)?.username || '');
    if (!delivery) return res.status(400).json({ error: '汇总预览不存在，请重新生成' });
    const report = JSON.parse(delivery.report_json);
    if (delivery.status === 'queued') return res.json({ queued: true, recipient: report.recipient, sentAt: delivery.sent_at });
    if (delivery.status !== 'preview') return res.status(409).json({ error: '该发送请求已处理或状态待核实，请查看发送记录' });
    if (Date.now() - Date.parse(delivery.created_at) > 15 * 60 * 1000) return res.status(409).json({ error: '汇总预览已过期，请重新生成' });
    try {
      const current = digestReports(report.asOf, report.kpiMode).reports.find((item) => item.report.managerKey === report.managerKey);
      if (current?.fingerprint !== delivery.fingerprint) return res.status(409).json({ error: '专线、标注或邮箱已变更，请重新生成汇总' });
    } catch (error) { return res.status(409).json({ error: error.message }); }
    db.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = db.prepare("SELECT id FROM warning_mail_digest WHERE fingerprint = ? AND status IN ('sending', 'queued', 'unknown')").get(delivery.fingerprint);
      if (duplicate) { db.exec('ROLLBACK'); return res.status(409).json({ error: '相同汇总已提交或发送状态待核实，请查看发送记录，避免重复提醒' }); }
      const changed = db.prepare("UPDATE warning_mail_digest SET status = 'sending' WHERE id = ? AND status = 'preview'").run(delivery.id);
      db.exec('COMMIT');
      if (!changed.changes) return res.status(409).json({ error: '汇总正在发送，请勿重复点击' });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    // With a fill link: the manager's own, made now and added under the summary, so they can
    // update their lines and forecasts straight from the message.
    let link = null;
    let body = report.body;
    if (req.body?.withLink === true && fillLinks) {
      const origin = String(req.body?.origin ?? '');
      const made = /^https?:\/\/[^/\s]+$/.test(origin)
        ? fillLinks.create({ manager: report.manager, scopes: digestLinkScopes, days: digestLinkDays, note: '' }, delivery.actor)
        : { error: '系统地址不正确' };
      if (made.error) {
        db.prepare("UPDATE warning_mail_digest SET status = 'preview' WHERE id = ?").run(delivery.id);
        return res.status(400).json({ error: `填报链接没有生成：${made.error}` });
      }
      link = made.link;
      body = [
        report.body,
        '',
        `如需补充台账信息或更新商机进度，可直接打开您的专属填报链接（${digestLinkDays} 天内有效，无需登录，只显示您名下的内容）：`,
        `${origin}/fill/${made.token}`,
        '拿到链接的人都能填写，请不要转发；需要在能打开专线台账管理系统的网络内使用。'
      ].join('\n');
    }
    try {
      const result = await mail.send({ ...report, body });
      if (result?.queued !== true) throw new Error('邮箱未确认接收该汇总');
    } catch (error) {
      const status = error.uncertain === false ? 'failed' : 'unknown';
      if (link && status === 'failed') fillLinks.discard(link.id);
      db.prepare('UPDATE warning_mail_digest SET status = ?, error = ? WHERE id = ?').run(status, error.message, delivery.id);
      return res.status(502).json({ error: status === 'unknown' ? `${error.message}；发送状态待核实，请先检查邮箱管理端，不要重复发送` : error.message, status });
    }
    const sentAt = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE warning_mail_digest SET status = 'queued', sent_at = ? WHERE id = ?").run(sentAt, delivery.id);
      const mark = db.prepare(`INSERT INTO line_warning_mark SELECT ?, 'remind', ?, ? WHERE EXISTS (SELECT 1 FROM leased_line WHERE id = ?)
        ON CONFLICT(line_id) DO UPDATE SET mark = 'remind', updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
      for (const lineId of report.lineIds) mark.run(lineId, delivery.actor, sentAt, lineId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); return res.status(500).json({ error: '邮件已提交但记录保存失败，请核实邮箱发送记录后再操作' }); }
    if (link) fillLinks.sent(link.id, report.recipient, { username: delivery.actor, source: requestSource(req), via: '欠费预警汇总' });
    res.json({ queued: true, recipient: report.recipient, sentAt, lineIds: report.lineIds, withLink: Boolean(link) });
  });

  router.get('/digest/history', (_req, res) => {
    const rows = db.prepare("SELECT id, manager_name, status, created_at, sent_at, error, report_json FROM warning_mail_digest WHERE status <> 'preview' ORDER BY created_at DESC LIMIT 30").all();
    res.json(rows.map(({ report_json, ...row }) => {
      const report = JSON.parse(report_json);
      return { ...row, recipient: report.recipient, lineCount: report.lineCount, asOf: report.asOf };
    }));
  });
  return router;
}
