import { Router } from 'express';
import XLSX from './xlsx.js';
import { agentMail } from './agent-mail.js';
import { mailText, parseExtensionMail } from './extension-parse.js';
import { ensureGroupDirectory } from './groups.js';

// Who builds the downstream part of a project. A named unit is kept as written.
export const downstreamKinds = { self: '自施工', supplier: '供应商安排', other: '其他单位' };
const defaultQuery = '专线延伸';
const maxText = 200;
const maxBody = 20000;

const textFields = ['group_code', 'group_name', 'manager_name', 'deliverer', 'product_code', 'product_account', 'downstream_name', 'remark'];
const amountFields = ['contract_amount', 'billing_amount', 'presale_amount', 'discount', 'profit_rate'];
const fieldLabels = {
  group_code: '集团编码', group_name: '集团名称', manager_name: '客户经理', deliverer: '交付商',
  contract_amount: '合同金额', billing_amount: '出账金额', presale_amount: '售前确认书金额', discount: '折扣', profit_rate: '移动侧利润',
  product_code: '产品编码', product_account: '产品账户', downstream_kind: '下游单位', downstream_name: '下游单位名称', tiers: '订购档次', remark: '备注'
};

/**
 * 专线延伸台账: one row per extension-service project, entered from its filing email (read from
 * the agent mailbox, or pasted) or by hand. What the mail states is read out for a person to
 * check before saving; the product code, product account and downstream unit are filled in
 * later. Each change is logged.
 */
export function createExtensionRouter({ db, currentUser, mail = agentMail }) {
  const router = Router();
  ensureGroupDirectory(db);
  db.exec(`
  CREATE TABLE IF NOT EXISTS line_extension (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_code TEXT,
    group_name TEXT,
    manager_name TEXT,
    contract_amount REAL,
    billing_amount REAL,
    presale_amount REAL,
    discount REAL,
    profit_rate REAL,
    deliverer TEXT,
    tiers_json TEXT NOT NULL DEFAULT '[]',
    product_code TEXT,
    product_account TEXT,
    downstream_kind TEXT,
    downstream_name TEXT,
    remark TEXT,
    source TEXT NOT NULL,
    mail_message_id TEXT UNIQUE,
    mail_subject TEXT,
    mail_from TEXT,
    mail_received_at TEXT,
    mail_attachments TEXT,
    mail_text TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_by TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS line_extension_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    extension_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    field_name TEXT,
    old_value TEXT,
    new_value TEXT,
    changed_by TEXT,
    changed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_line_extension_log ON line_extension_log(extension_id, id);
  `);

  const username = (req) => currentUser(req)?.username || '';
  const text = (value) => String(value ?? '').trim();

  // What the ledger and the full group list say about a group, to check the mail against.
  function knownGroup(code) {
    if (!code) return null;
    const ledger = db.prepare(`SELECT MAX(group_name) AS group_name,
        (SELECT manager_name FROM leased_line m WHERE m.group_code = ? AND COALESCE(m.manager_name, '') <> ''
         GROUP BY manager_name ORDER BY COUNT(*) DESC, manager_name LIMIT 1) AS manager_name
      FROM leased_line WHERE group_code = ?`).get(code, code);
    if (ledger?.group_name) return { ...ledger, from: 'ledger' };
    const listed = db.prepare('SELECT group_name, manager_name FROM group_directory WHERE group_code = ?').get(code);
    return listed ? { ...listed, from: 'directory' } : null;
  }

  // The line a product code (the numeric 集团产品编码) names, when the ledger has it.
  function lineFor(code) {
    if (!code) return null;
    return db.prepare(`SELECT id, group_product_code, group_user_name, product_name, group_product_account_id,
        COALESCE(product_status_name, ledger_status, '') AS status FROM leased_line WHERE group_product_code = ?`).get(code) || null;
  }

  const view = (row) => {
    const tiers = JSON.parse(row.tiers_json || '[]');
    const missing = [!row.product_code && '产品编码', !row.product_account && '产品账户', !row.downstream_kind && '下游单位'].filter(Boolean);
    return {
      ...row,
      tiers,
      tiers_json: undefined,
      mail_text: undefined,
      mail_attachments: JSON.parse(row.mail_attachments || '[]'),
      downstream: row.downstream_kind === 'other' ? row.downstream_name || '' : downstreamKinds[row.downstream_kind] || '',
      missing,
      line: lineFor(row.product_code)
    };
  };

  /** Checks a record as sent from the page; returns { error } or { values }. */
  function clean(body, { partial = false } = {}) {
    const values = {};
    for (const field of textFields) {
      if (!Object.hasOwn(body, field)) continue;
      const value = text(body[field]);
      if (value.length > maxText) return { error: `${fieldLabels[field]}不能超过 ${maxText} 字` };
      values[field] = value || null;
    }
    for (const field of amountFields) {
      if (!Object.hasOwn(body, field)) continue;
      const raw = body[field];
      if (raw === null || raw === '' || raw === undefined) { values[field] = null; continue; }
      const number = Number(String(raw).replace(/[,，]/g, ''));
      if (!Number.isFinite(number) || number < 0) return { error: `${fieldLabels[field]}须为不小于 0 的数字` };
      values[field] = Math.round(number * 100) / 100;
    }
    if (Object.hasOwn(body, 'downstream_kind')) {
      const kind = text(body.downstream_kind);
      if (kind && !Object.hasOwn(downstreamKinds, kind)) return { error: '下游单位只能选自施工、供应商安排或填写单位名称' };
      values.downstream_kind = kind || null;
      if (kind !== 'other') values.downstream_name = null;
      else if (!text(body.downstream_name)) return { error: '请填写下游单位名称' };
    }
    if (values.product_code && !/^\d+$/.test(values.product_code)) return { error: '产品编码请填写集团产品编码的数字' };
    if (Object.hasOwn(body, 'tiers')) {
      if (!Array.isArray(body.tiers) || body.tiers.length > 20) return { error: '订购档次不正确' };
      const tiers = [];
      for (const tier of body.tiers) {
        const name = text(tier?.name);
        const price = Number(tier?.price);
        const times = Number(tier?.times);
        if (!name && !tier?.price && !tier?.times) continue;
        if (!name || name.length > 60) return { error: '每个档次都要有名称' };
        if (!Number.isFinite(price) || price < 0 || !Number.isSafeInteger(times) || times <= 0) return { error: `档次“${name}”的单价须为数字、次数须为正整数` };
        tiers.push({ name, price: Math.round(price * 100) / 100, times, subtotal: Math.round(price * times * 100) / 100 });
      }
      values.tiers_json = JSON.stringify(tiers);
    }
    if (!partial) {
      if (!values.group_code && !values.group_name) return { error: '请至少填写集团编码或集团名称' };
    }
    return { values };
  }

  const columnsOf = (values) => Object.keys(values);
  function log(id, action, changes, by, at) {
    const insert = db.prepare('INSERT INTO line_extension_log (extension_id, action, field_name, old_value, new_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    if (!changes.length) insert.run(id, action, null, null, null, by, at);
    for (const change of changes) insert.run(id, action, change.field, change.from, change.to, by, at);
  }

  // ---- reading filing emails ----

  router.get('/mail', async (req, res) => {
    const q = text(req.query.q) || defaultQuery;
    if (q.length > 40) return res.status(400).json({ error: '搜索词不能超过 40 字' });
    let messages;
    try {
      messages = await mail.search({ q, limit: 30 });
    } catch (error) {
      return res.status(502).json({ error: `读取邮箱失败：${error.message}` });
    }
    const imported = new Map(db.prepare('SELECT mail_message_id, id FROM line_extension WHERE mail_message_id IS NOT NULL').all().map((row) => [row.mail_message_id, row.id]));
    res.json({
      q,
      messages: messages.map((item) => ({
        id: item.message_id,
        subject: item.subject || '',
        from: item.from?.name || item.from?.email || '',
        fromEmail: item.from?.email || '',
        at: item.created_at || null,
        snippet: mailText(item.snippet || '', 'html').slice(0, 160),
        importedId: imported.get(item.message_id) ?? null
      }))
    });
  });

  // One mail read and read out into a draft; nothing is saved.
  router.post('/mail/:id/parse', async (req, res) => {
    const id = String(req.params.id);
    if (!/^msg_[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: '邮件编号不正确' });
    const existing = db.prepare('SELECT id FROM line_extension WHERE mail_message_id = ?').get(id);
    let message;
    try {
      message = await mail.read(id);
    } catch (error) {
      return res.status(error.uncertain === false ? 400 : 502).json({ error: `读取邮件失败：${error.message}` });
    }
    const body = mailText(message?.body || '', message?.body_format || '');
    const parsed = parseExtensionMail(body);
    res.json({
      ...result(parsed),
      importedId: existing?.id ?? null,
      mail: {
        id,
        subject: message?.subject || '',
        from: message?.from?.name || message?.from?.email || '',
        fromEmail: message?.from?.email || '',
        at: message?.created_at || null,
        attachments: (message?.attachments || []).map((item) => item.filename).filter(Boolean)
      }
    });
  });

  // Pasted text read out the same way, for a mail that did not reach the agent mailbox.
  router.post('/parse', (req, res) => {
    const body = String(req.body?.text ?? '');
    if (!body.trim()) return res.status(400).json({ error: '请粘贴邮件正文' });
    if (body.length > maxBody) return res.status(400).json({ error: '正文太长，请只粘贴邮件内容' });
    res.json(result(parseExtensionMail(body)));
  });

  function result(parsed) {
    const known = knownGroup(parsed.draft.group_code);
    const notes = [...parsed.warnings];
    if (parsed.draft.group_code && !known) notes.push('台账和全量集团清单中都没有这个集团编码，请核对');
    if (known?.manager_name && parsed.draft.manager_name && known.manager_name !== parsed.draft.manager_name) {
      notes.push(`邮件写的客户经理是 ${parsed.draft.manager_name}，${known.from === 'ledger' ? '台账' : '全量集团清单'}中是 ${known.manager_name}`);
    }
    if (known?.group_name && parsed.draft.group_name && known.group_name !== parsed.draft.group_name) {
      notes.push(`邮件写的集团名称与${known.from === 'ledger' ? '台账' : '全量集团清单'}不同：${known.group_name}`);
    }
    return { draft: parsed.draft, missing: parsed.missing, warnings: notes, tierTotal: parsed.tierTotal, text: parsed.text.slice(0, maxBody) };
  }

  // ---- the ledger ----

  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM line_extension ORDER BY created_at DESC, id DESC').all().map(view);
    const managers = [...new Set(rows.map((row) => row.manager_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const sum = (key) => Math.round(rows.reduce((total, row) => total + (row[key] ?? 0), 0) * 100) / 100;
    res.json({
      rows,
      managers,
      downstreamKinds,
      summary: { count: rows.length, contract: sum('contract_amount'), billing: sum('billing_amount'), presale: sum('presale_amount'), incomplete: rows.filter((row) => row.missing.length).length }
    });
  });

  router.get('/:id/log', (req, res) => {
    res.json(db.prepare('SELECT * FROM line_extension_log WHERE extension_id = ? ORDER BY id DESC LIMIT 200').all(Number(req.params.id)));
  });

  router.post('/', (req, res) => {
    const body = req.body || {};
    const checked = clean(body);
    if (checked.error) return res.status(400).json({ error: checked.error });
    const source = ['mail', 'paste', 'manual'].includes(body.source) ? body.source : 'manual';
    const mailInfo = body.mail || {};
    const messageId = source === 'mail' ? text(mailInfo.id) : '';
    if (source === 'mail' && !/^msg_[A-Za-z0-9_-]+$/.test(messageId)) return res.status(400).json({ error: '邮件编号不正确' });
    if (messageId && db.prepare('SELECT 1 FROM line_extension WHERE mail_message_id = ?').get(messageId)) {
      return res.status(409).json({ error: '这封邮件已经录入过了' });
    }
    const at = new Date().toISOString();
    const values = {
      tiers_json: '[]',
      ...checked.values,
      source,
      mail_message_id: messageId || null,
      mail_subject: text(mailInfo.subject).slice(0, maxText) || null,
      mail_from: text(mailInfo.from).slice(0, maxText) || null,
      mail_received_at: text(mailInfo.at) || null,
      mail_attachments: JSON.stringify(Array.isArray(mailInfo.attachments) ? mailInfo.attachments.slice(0, 30).map((name) => String(name).slice(0, 200)) : []),
      mail_text: source === 'manual' ? null : String(body.text ?? '').slice(0, maxBody) || null,
      created_by: username(req), created_at: at, updated_by: username(req), updated_at: at
    };
    const columns = columnsOf(values);
    const result = db.prepare(`INSERT INTO line_extension (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map((key) => values[key]));
    const id = Number(result.lastInsertRowid);
    log(id, { mail: '从邮件录入', paste: '从粘贴的正文录入', manual: '手动新增' }[source], [], username(req), at);
    res.status(201).json(view(db.prepare('SELECT * FROM line_extension WHERE id = ?').get(id)));
  });

  router.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM line_extension WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '记录不存在' });
    const checked = clean(req.body || {}, { partial: true });
    if (checked.error) return res.status(400).json({ error: checked.error });
    const changes = [];
    for (const [field, value] of Object.entries(checked.values)) {
      const before = existing[field] ?? null;
      if (String(before ?? '') === String(value ?? '')) continue;
      changes.push({ field: field === 'tiers_json' ? 'tiers' : field, from: before === null ? null : String(before), to: value === null ? null : String(value) });
    }
    const merged = { ...existing, ...checked.values };
    if (!merged.group_code && !merged.group_name) return res.status(400).json({ error: '请至少保留集团编码或集团名称' });
    if (changes.length) {
      const at = new Date().toISOString();
      const values = { ...checked.values, updated_by: username(req), updated_at: at };
      const columns = columnsOf(values);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`UPDATE line_extension SET ${columns.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`).run(...columns.map((key) => values[key]), id);
        log(id, 'edit', changes, username(req), at);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    res.json({ ...view(db.prepare('SELECT * FROM line_extension WHERE id = ?').get(id)), changed: changes.length });
  });

  // Deleting keeps the log, with the row as it was, so the deletion can be traced.
  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM line_extension WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '记录不存在' });
    const at = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const { mail_text: _ignored, ...kept } = existing;
      log(id, 'delete', [{ field: 'record', from: JSON.stringify(kept), to: null }], username(req), at);
      db.prepare('DELETE FROM line_extension WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json({ id });
  });

  router.get('/:id/text', (req, res) => {
    const row = db.prepare('SELECT mail_text, mail_subject FROM line_extension WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '记录不存在' });
    res.json({ subject: row.mail_subject, text: row.mail_text || '' });
  });

  router.get('/export/xlsx', (req, res) => {
    // ?ids=1,2,3 limits the export to the rows the page is showing (an empty list exports none).
    const only = typeof req.query.ids === 'string'
      ? new Set(req.query.ids.split(',').map(Number).filter((id) => Number.isInteger(id) && id > 0))
      : null;
    const rows = db.prepare('SELECT * FROM line_extension ORDER BY created_at DESC, id DESC').all()
      .filter((row) => !only || only.has(row.id)).map(view);
    const sheet = XLSX.utils.json_to_sheet(rows.map((row) => ({
      集团编码: row.group_code || '', 集团名称: row.group_name || '', 客户经理: row.manager_name || '',
      合同金额: row.contract_amount, 出账金额: row.billing_amount, 售前确认书金额: row.presale_amount,
      折扣: row.discount === null ? '' : `${row.discount}%`, 移动侧利润: row.profit_rate === null ? '' : `${row.profit_rate}%`,
      交付商: row.deliverer || '',
      订购档次: row.tiers.map((tier) => `${tier.name} ${tier.price}元/次×${tier.times}次`).join('；'),
      产品编码: row.product_code || '', 产品账户: row.product_account || '', 下游单位: row.downstream || '',
      备注: row.remark || '', 来源邮件: row.mail_subject || '', 录入时间: row.created_at
    })));
    for (let index = 1; index <= rows.length; index += 1) {
      for (const column of [0, 11, 12]) {
        const cell = sheet[XLSX.utils.encode_cell({ r: index, c: column })];
        if (cell) { cell.t = 's'; cell.z = '@'; }
      }
    }
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '专线延伸台账');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="extensions.xlsx"; filename*=UTF-8''${encodeURIComponent('专线延伸台账.xlsx')}`);
    res.send(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  });

  return router;
}
