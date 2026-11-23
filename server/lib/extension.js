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
  -- What the system knows about a mail in the mailbox: what it said when it was last read out,
  -- and whether it was set aside (a repeat, or nothing to enter). The mailbox itself is never changed.
  CREATE TABLE IF NOT EXISTS line_extension_mail (
    message_id TEXT PRIMARY KEY,
    subject TEXT,
    content_key TEXT,
    parsed_at TEXT,
    skipped_reason TEXT,
    skipped_by TEXT,
    skipped_at TEXT
  );
  `);

  const username = (req) => currentUser(req)?.username || '';
  const text = (value) => String(value ?? '').trim();

  // ---- telling repeats apart ----

  // A subject without the forward/reply prefixes a mail picks up when it is passed on again.
  function subjectKey(subject) {
    let value = text(subject);
    let before;
    do {
      before = value;
      value = value.replace(/^\s*(?:(?:fwd?|re|转发|回复|答复)\s*[:：]|[[【(（]\s*(?:fwd?|转发)\s*[\]】)）])\s*/i, '');
    } while (value !== before);
    return value.replace(/\s+/g, '');
  }

  // The figures that make a project: group code, amounts and the price × times of each tier.
  // Two filings with the same key are almost surely the same project sent twice.
  function contentKey(record) {
    const code = text(record.group_code);
    const amount = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '' : String(Math.round(Number(value) * 100) / 100));
    const amounts = [record.contract_amount, record.billing_amount, record.presale_amount].map(amount);
    const tiers = (record.tiers || []).map((tier) => `${amount(tier.price)}x${Number(tier.times) || 0}`).sort().join(',');
    if (!code || (amounts.every((value) => !value) && !tiers)) return null;
    return [code, ...amounts, tiers].join('|');
  }

  // Projects already in the ledger, by content key and by the subject of the mail they came from.
  function ledgerKeys() {
    const byContent = new Map();
    const bySubject = new Map();
    for (const row of db.prepare('SELECT id, group_code, group_name, contract_amount, billing_amount, presale_amount, tiers_json, mail_message_id, mail_subject, created_at FROM line_extension').all()) {
      const record = { ...row, tiers: JSON.parse(row.tiers_json || '[]') };
      const key = contentKey(record);
      if (key) byContent.set(key, [...(byContent.get(key) || []), record]);
      const subject = subjectKey(row.mail_subject);
      if (subject) bySubject.set(subject, [...(bySubject.get(subject) || []), record]);
    }
    return { byContent, bySubject };
  }
  const projectName = (record) => `“${record.group_name || record.group_code || '未命名项目'}”（${String(record.created_at || '').slice(0, 10)} 录入）`;

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

  // Mails already entered or set aside are left out unless ?all=1; the rest say when they look
  // like a repeat of another mail or of a project already in the ledger.
  router.get('/mail', async (req, res) => {
    const q = text(req.query.q) || defaultQuery;
    if (q.length > 40) return res.status(400).json({ error: '搜索词不能超过 40 字' });
    const showAll = req.query.all === '1';
    let messages;
    try {
      messages = await mail.search({ q, limit: 30 });
    } catch (error) {
      return res.status(502).json({ error: `读取邮箱失败：${error.message}` });
    }
    const imported = new Map(db.prepare('SELECT mail_message_id, id, group_name FROM line_extension WHERE mail_message_id IS NOT NULL').all().map((row) => [row.mail_message_id, row]));
    const known = new Map(db.prepare('SELECT * FROM line_extension_mail').all().map((row) => [row.message_id, row]));
    const { byContent, bySubject } = ledgerKeys();
    const mailsByContent = new Map();
    for (const row of known.values()) {
      if (row.content_key && !imported.has(row.message_id)) mailsByContent.set(row.content_key, [...(mailsByContent.get(row.content_key) || []), row.message_id]);
    }
    const subjectCount = new Map();
    for (const item of messages) {
      if (imported.has(item.message_id) || known.get(item.message_id)?.skipped_at) continue;
      const key = subjectKey(item.subject);
      if (key) subjectCount.set(key, (subjectCount.get(key) || 0) + 1);
    }

    const list = messages.map((item) => {
      const entered = imported.get(item.message_id);
      const record = known.get(item.message_id);
      const repeats = [];
      if (!entered) {
        const subject = subjectKey(item.subject);
        const sameSubject = (bySubject.get(subject) || []).filter((row) => row.mail_message_id !== item.message_id);
        if (sameSubject.length) repeats.push(`与已录入的项目${projectName(sameSubject[0])}的邮件主题相同，可能是重复转发`);
        else if (subject && subjectCount.get(subject) > 1) repeats.push(`还有 ${subjectCount.get(subject) - 1} 封主题相同的邮件，可能是重复转发`);
        const sameContent = record?.content_key ? byContent.get(record.content_key) || [] : [];
        if (sameContent.length) repeats.push(`内容与已录入的项目${projectName(sameContent[0])}相同`);
        else if (record?.content_key && (mailsByContent.get(record.content_key) || []).some((id) => id !== item.message_id)) repeats.push('内容与另一封未录入的邮件相同');
      }
      return {
        id: item.message_id,
        subject: item.subject || '',
        from: item.from?.name || item.from?.email || '',
        fromEmail: item.from?.email || '',
        at: item.created_at || null,
        snippet: mailText(item.snippet || '', 'html').slice(0, 160),
        importedId: entered?.id ?? null,
        importedName: entered?.group_name || null,
        skipped: record?.skipped_at ? { reason: record.skipped_reason, by: record.skipped_by, at: record.skipped_at } : null,
        repeats
      };
    });
    const handled = (item) => item.importedId || item.skipped;
    res.json({
      q,
      messages: showAll ? list : list.filter((item) => !handled(item)),
      hidden: { imported: list.filter((item) => item.importedId).length, skipped: list.filter((item) => !item.importedId && item.skipped).length }
    });
  });

  // Setting a mail aside (a repeat, or nothing to enter) so it is no longer listed; and undoing that.
  router.post('/mail/:id/skip', (req, res) => {
    const id = String(req.params.id);
    if (!/^msg_[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: '邮件编号不正确' });
    const reason = text(req.body?.reason) || '无需录入';
    if (reason.length > 60) return res.status(400).json({ error: '原因不能超过 60 字' });
    const subject = text(req.body?.subject).slice(0, maxText) || null;
    db.prepare(`INSERT INTO line_extension_mail (message_id, subject, skipped_reason, skipped_by, skipped_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET subject = COALESCE(line_extension_mail.subject, excluded.subject),
        skipped_reason = excluded.skipped_reason, skipped_by = excluded.skipped_by, skipped_at = excluded.skipped_at`)
      .run(id, subject, reason, username(req), new Date().toISOString());
    res.json({ id, reason });
  });

  router.delete('/mail/:id/skip', (req, res) => {
    const id = String(req.params.id);
    if (!/^msg_[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: '邮件编号不正确' });
    db.prepare('UPDATE line_extension_mail SET skipped_reason = NULL, skipped_by = NULL, skipped_at = NULL WHERE message_id = ?').run(id);
    res.json({ id });
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
    const key = contentKey(parsed.draft);
    const skipped = db.prepare('SELECT skipped_reason, skipped_at FROM line_extension_mail WHERE message_id = ?').get(id);
    // Remember what this mail said, so a second copy of it can be recognised.
    db.prepare(`INSERT INTO line_extension_mail (message_id, subject, content_key, parsed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET subject = excluded.subject, content_key = excluded.content_key, parsed_at = excluded.parsed_at`)
      .run(id, text(message?.subject).slice(0, maxText) || null, key, new Date().toISOString());
    res.json({
      ...result(parsed, { messageId: id, subject: message?.subject }),
      importedId: existing?.id ?? null,
      skipped: skipped?.skipped_at ? { reason: skipped.skipped_reason, at: skipped.skipped_at } : null,
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

  // Signs that this filing was entered already, or reached the mailbox more than once.
  function repeatsOf(draft, { messageId = null, subject = '' } = {}) {
    const notes = [];
    const { byContent, bySubject } = ledgerKeys();
    const key = contentKey(draft);
    const sameContent = key ? (byContent.get(key) || []).filter((row) => row.mail_message_id !== messageId) : [];
    if (sameContent.length) notes.push(`已经录入过内容相同的项目${projectName(sameContent[0])}，集团编码、金额和档次都一样`);
    const sameSubject = messageId ? (bySubject.get(subjectKey(subject)) || []).filter((row) => row.mail_message_id !== messageId && !sameContent.includes(row)) : [];
    if (sameSubject.length) notes.push(`已录入的项目${projectName(sameSubject[0])}来自一封主题相同的邮件`);
    if (messageId && key) {
      const imported = new Set(db.prepare('SELECT mail_message_id FROM line_extension WHERE mail_message_id IS NOT NULL').all().map((row) => row.mail_message_id));
      const others = db.prepare('SELECT message_id, subject FROM line_extension_mail WHERE content_key = ? AND message_id <> ?').all(key, messageId)
        .filter((row) => !imported.has(row.message_id));
      if (others.length) notes.push(`另一封邮件“${others[0].subject || '（无主题）'}”的内容与这封相同，尚未录入`);
    }
    return notes;
  }

  function result(parsed, mailInfo) {
    const known = knownGroup(parsed.draft.group_code);
    const notes = [...parsed.warnings];
    if (parsed.draft.group_code && !known) notes.push('台账和全量集团清单中都没有这个集团编码，请核对');
    if (known?.manager_name && parsed.draft.manager_name && known.manager_name !== parsed.draft.manager_name) {
      notes.push(`邮件写的客户经理是 ${parsed.draft.manager_name}，${known.from === 'ledger' ? '台账' : '全量集团清单'}中是 ${known.manager_name}`);
    }
    if (known?.group_name && parsed.draft.group_name && known.group_name !== parsed.draft.group_name) {
      notes.push(`邮件写的集团名称与${known.from === 'ledger' ? '台账' : '全量集团清单'}不同：${known.group_name}`);
    }
    return {
      draft: parsed.draft, missing: parsed.missing, warnings: notes, repeats: repeatsOf(parsed.draft, mailInfo),
      tierTotal: parsed.tierTotal, text: parsed.text.slice(0, maxBody)
    };
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
    // The same project entered twice (a mail forwarded again, or pasted after it was entered)
    // is stopped until the person says it is not a repeat.
    const key = contentKey({ ...checked.values, tiers: JSON.parse(checked.values.tiers_json || '[]') });
    const same = key && !body.confirmRepeat ? ledgerKeys().byContent.get(key) : null;
    if (same?.length) {
      return res.status(409).json({ error: `已经录入过内容相同的项目${projectName(same[0])}。如果确认不是重复，请勾选“不是重复，仍然录入”后再保存`, repeat: true });
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
