import crypto from 'node:crypto';
import { Router } from 'express';
import { agentMail } from './agent-mail.js';
import { requestSource } from './client-cert.js';
import { managerKey } from './warning-mail.js';
import { billableStatuses } from './ledger-rules.js';
import { confidenceLevels, forecastKinds } from './kpi.js';

// What a fill link can be for. One link may carry several.
export const shareScopes = {
  ledger: '台账补充信息',
  progress: '商机进度',
  report: '商机上报'
};
// The hand-kept ledger fields a link may write: fewer than the signed-in user can edit.
export const fillFields = [
  'actual_monthly_fee', 'contract_no', 'contract_start_date', 'contract_end_date', 'renewal_status',
  'customer_contact', 'customer_phone', 'project_name', 'remark'
];
const fieldLabels = {
  actual_monthly_fee: '实际月资费', contract_no: '合同编号', contract_start_date: '合同开始日期', contract_end_date: '合同结束日期',
  renewal_status: '续约状态', customer_contact: '客户联系人', customer_phone: '联系电话', project_name: '项目名称', remark: '备注'
};
const dateFields = ['contract_start_date', 'contract_end_date'];
const maxDays = 30;
const maxText = 200;
const maxBadTokens = 20;
const badTokenWindowMs = 15 * 60 * 1000;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * 填报链接: a link that lets one manager, without an account, fill in the hand-kept fields of
 * their own lines, report progress on their own forecasts, or register a forecast, until it
 * expires or is revoked. Only the token's hash is stored, so a link cannot be read back out of
 * the database; every write goes through the same code as a signed-in edit and is logged.
 */
export function createShareService({ db, currentUser, updateLine, kpi, productTypes, logEvent = () => {}, mail = agentMail, linkBase = (fallback) => fallback }) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS share_link (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    manager_name TEXT NOT NULL,
    scopes TEXT NOT NULL,
    note TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    open_count INTEGER NOT NULL DEFAULT 0,
    submit_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS share_submission (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL REFERENCES share_link(id),
    at TEXT NOT NULL,
    source TEXT,
    kind TEXT NOT NULL,
    target TEXT,
    summary TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_share_submission_link ON share_submission(link_id, id);
  `);

  // Links made before they could be sent by mail have no record of a recipient.
  const linkColumns = db.prepare("SELECT name FROM pragma_table_info('share_link')").all().map((row) => row.name);
  if (!linkColumns.includes('sent_to')) db.exec('ALTER TABLE share_link ADD COLUMN sent_to TEXT; ALTER TABLE share_link ADD COLUMN sent_at TEXT;');

  const state = (link) => (link.revoked_at ? 'revoked' : new Date(link.expires_at).getTime() <= Date.now() ? 'expired' : 'active');
  const view = (link) => ({
    id: link.id, manager: link.manager_name, scopes: JSON.parse(link.scopes), note: link.note || '', state: state(link),
    expiresAt: link.expires_at, revokedAt: link.revoked_at, createdBy: link.created_by, createdAt: link.created_at,
    openCount: link.open_count, submitCount: link.submit_count, lastUsedAt: link.last_used_at,
    sentTo: link.sent_to || '', sentAt: link.sent_at
  });
  const actor = (link) => `填报链接·${link.manager_name}`;

  // ---- signed-in side: make, list and revoke links ----
  const adminRouter = Router();

  adminRouter.get('/', (_req, res) => {
    const links = db.prepare('SELECT * FROM share_link ORDER BY id DESC LIMIT 200').all().map(view);
    const managers = db.prepare("SELECT DISTINCT manager_name AS name FROM leased_line WHERE COALESCE(manager_name, '') <> '' ORDER BY manager_name").all().map((row) => row.name);
    res.json({ links, managers, emails: Object.fromEntries(managers.map((name) => [name, emailOf(name)]).filter(([, email]) => email)), scopes: Object.entries(shareScopes).map(([key, label]) => ({ key, label })), maxDays,
      // Set while the fill port is on: links then start with the public address.
      linkBase: linkBase('') });
  });

  // The address saved for a manager on the arrears warning page, by job number or by name.
  function emailOf(manager) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'warning_mail_contact'").get()) return '';
    const keys = new Set(db.prepare('SELECT DISTINCT manager_job_no, manager_name FROM leased_line WHERE manager_name = ?').all(manager).map(managerKey));
    keys.add(`name:${manager}`);
    for (const key of keys) {
      const email = db.prepare('SELECT email FROM warning_mail_contact WHERE manager_key = ?').get(key)?.email;
      if (email) return email;
    }
    return '';
  }

  // Checks what was asked for and stores the link. Returns { error } or { link, token, days }.
  function makeLink(req) {
    return makeLinkFor(req.body || {}, currentUser(req)?.username || '');
  }
  function makeLinkFor(input, username) {
    const manager = String(input.manager ?? '').trim();
    const scopes = [...new Set(Array.isArray(input.scopes) ? input.scopes : [])].filter((key) => Object.hasOwn(shareScopes, key));
    const days = Number(input.days);
    const note = String(input.note ?? '').trim();
    if (!manager || manager.length > 40) return { error: '请选择客户经理' };
    if (!scopes.length) return { error: '请至少选择一项填报内容' };
    if (!Number.isFinite(days) || days <= 0 || days > maxDays) return { error: `有效期须在 ${maxDays} 天以内` };
    if (note.length > maxText) return { error: `备注不能超过 ${maxText} 字` };
    const token = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    const result = db.prepare(
      'INSERT INTO share_link (token_hash, manager_name, scopes, note, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(hashToken(token), manager, JSON.stringify(scopes), note, new Date(now.getTime() + days * 86400000).toISOString(), username, now.toISOString());
    return { link: db.prepare('SELECT * FROM share_link WHERE id = ?').get(Number(result.lastInsertRowid)), token, days };
  }
  const describe = (link, days) => `${link.manager_name} · ${JSON.parse(link.scopes).map((key) => shareScopes[key]).join('、')} · ${days} 天`;

  adminRouter.post('/', (req, res) => {
    const made = makeLink(req);
    if (made.error) return res.status(400).json({ error: made.error });
    logEvent('share_created', { username: currentUser(req)?.username || '', source: requestSource(req), detail: describe(made.link, made.days) });
    // The only time the token leaves the server.
    res.status(201).json({ ...view(made.link), path: `/fill/${made.token}` });
  });

  /**
   * Makes a link for one manager and mails it to the address saved for them, with no copies: the
   * link is for its recipient alone. A link whose message certainly did not go out is removed;
   * one whose delivery is unknown stays, so a message that did arrive still works.
   */
  adminRouter.post('/send', async (req, res) => {
    const origin = String(req.body?.origin ?? '');
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) return res.status(400).json({ error: '系统地址不正确' });
    const manager = String(req.body?.manager ?? '').trim();
    const recipient = manager ? emailOf(manager) : '';
    if (manager && !recipient) return res.status(400).json({ error: `还没有设置 ${manager} 的邮箱，请到“欠费销户预警 → 客户经理邮箱”填写` });
    const made = makeLink(req);
    if (made.error) return res.status(400).json({ error: made.error });
    const { link, token, days } = made;
    const scopes = JSON.parse(link.scopes);
    const expires = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(link.expires_at));
    const body = [
      `${link.manager_name}，您好：`,
      '',
      `请通过下面的专属链接填写：${scopes.map((key) => shareScopes[key]).join('、')}。`,
      ...(link.note ? ['', `说明：${link.note}`] : []),
      '',
      `${linkBase(origin)}/fill/${token}`,
      '',
      `有效期至 ${expires}（北京时间），过期后链接失效。`,
      '打开链接不需要登录，只显示您名下的内容，每次保存都会留下记录。',
      '这是您的专属链接，拿到链接的人都能填写，请不要转发。',
      '需要在能打开专线台账管理系统的网络内使用。'
    ].join('\n');
    try {
      const result = await mail.send({ recipient, subject: `专线填报链接｜${link.manager_name}｜有效期至 ${expires}`, body, copy: false });
      if (result?.queued !== true) throw new Error('邮箱未确认接收这封邮件');
    } catch (error) {
      const actor = { username: currentUser(req)?.username || '', source: requestSource(req) };
      if (error.uncertain === false) {
        db.prepare('DELETE FROM share_link WHERE id = ?').run(link.id);
        return res.status(502).json({ error: `${error.message}。链接没有生成。`, status: 'failed' });
      }
      logEvent('share_created', { ...actor, detail: `${describe(link, days)} · 邮件发送状态待核实（${recipient}）` });
      return res.status(502).json({ error: `${error.message}；发送状态待核实，请先检查邮箱管理端。链接已生成，如确认没有发出，请作废后重发`, status: 'unknown', link: view(link) });
    }
    const sentAt = new Date().toISOString();
    db.prepare('UPDATE share_link SET sent_to = ?, sent_at = ? WHERE id = ?').run(recipient, sentAt, link.id);
    logEvent('share_created', { username: currentUser(req)?.username || '', source: requestSource(req), detail: `${describe(link, days)} · 已邮件发送至 ${recipient}` });
    res.status(201).json({ ...view(db.prepare('SELECT * FROM share_link WHERE id = ?').get(link.id)), recipient });
  });

  adminRouter.post('/:id/revoke', (req, res) => {
    const link = db.prepare('SELECT * FROM share_link WHERE id = ?').get(Number(req.params.id));
    if (!link) return res.status(404).json({ error: '链接不存在' });
    if (!link.revoked_at) {
      db.prepare('UPDATE share_link SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), link.id);
      logEvent('share_revoked', { username: currentUser(req)?.username || '', source: requestSource(req), detail: `${link.manager_name} 的填报链接` });
    }
    res.json(view(db.prepare('SELECT * FROM share_link WHERE id = ?').get(link.id)));
  });

  adminRouter.get('/submissions', (req, res) => {
    const linkId = Number(req.query.link);
    const rows = db.prepare(
      `SELECT s.id, s.link_id, s.at, s.source, s.kind, s.target, s.summary, l.manager_name
       FROM share_submission s JOIN share_link l ON l.id = s.link_id
       ${Number.isSafeInteger(linkId) && linkId > 0 ? 'WHERE s.link_id = ?' : ''}
       ORDER BY s.id DESC LIMIT 200`
    ).all(...(Number.isSafeInteger(linkId) && linkId > 0 ? [linkId] : []));
    res.json(rows);
  });

  // ---- public side: reached with the token alone ----
  const publicRouter = Router();
  const badTokens = new Map();

  function tooManyBadTokens(source) {
    const entry = badTokens.get(source);
    return Boolean(entry) && entry.until > Date.now() && entry.count >= maxBadTokens;
  }
  function noteBadToken(source) {
    const now = Date.now();
    for (const [key, entry] of badTokens) if (entry.until <= now) badTokens.delete(key);
    const entry = badTokens.get(source);
    if (entry && entry.until > now) entry.count += 1;
    else badTokens.set(source, { count: 1, until: now + badTokenWindowMs });
  }

  // Resolves the link or answers the request itself. A link that is over says so; an unknown
  // token says nothing about what exists.
  function linkFor(req, res, scope) {
    const source = requestSource(req);
    if (tooManyBadTokens(source)) {
      res.status(429).json({ error: '尝试次数过多，请稍后再试' });
      return null;
    }
    const link = db.prepare('SELECT * FROM share_link WHERE token_hash = ?').get(hashToken(req.params.token));
    if (!link) {
      noteBadToken(source);
      res.status(404).json({ error: '链接无效' });
      return null;
    }
    const current = state(link);
    if (current !== 'active') {
      res.status(410).json({ error: current === 'revoked' ? '这个链接已被作废，请联系发给你链接的人' : '这个链接已过期，请联系发给你链接的人重新生成' });
      return null;
    }
    if (scope && !JSON.parse(link.scopes).includes(scope)) {
      res.status(403).json({ error: '这个链接不能填写这项内容' });
      return null;
    }
    return link;
  }

  function record(req, link, kind, target, summary) {
    const at = new Date().toISOString();
    const source = requestSource(req);
    db.prepare('INSERT INTO share_submission (link_id, at, source, kind, target, summary) VALUES (?, ?, ?, ?, ?, ?)').run(link.id, at, source, kind, String(target), summary);
    db.prepare('UPDATE share_link SET submit_count = submit_count + 1, last_used_at = ? WHERE id = ?').run(at, link.id);
    logEvent('share_submitted', { username: actor(link), source, detail: summary.slice(0, 200) });
  }

  const lineColumns = ['id', 'group_code', 'group_name', 'group_product_code', 'group_user_name', 'product_name', 'bandwidth', 'start_time', 'package_fee', ...fillFields];
  const linesOf = (manager) => db.prepare(
    `SELECT ${lineColumns.join(', ')}, COALESCE(product_status_name, ledger_status, '') AS status
     FROM leased_line
     WHERE manager_name = ? AND COALESCE(product_status_name, ledger_status, '') IN (${billableStatuses.map(() => '?').join(', ')})
     ORDER BY group_name, group_product_code, id`
  ).all(manager, ...billableStatuses);

  function payload(link) {
    const scopes = JSON.parse(link.scopes);
    const forecasts = scopes.includes('progress') ? kpi().forecastsOf(link.manager_name) : [];
    return {
      manager: link.manager_name,
      scopes,
      scopeLabels: shareScopes,
      note: link.note || '',
      expiresAt: link.expires_at,
      fillFields,
      lines: scopes.includes('ledger') ? linesOf(link.manager_name) : [],
      forecasts,
      report: scopes.includes('report') ? { productTypes, months: kpi().openMonths(), confidenceLevels: confidenceLevels.filter((level) => level !== 'unrated'), kinds: forecastKinds } : null
    };
  }

  publicRouter.get('/:token', (req, res) => {
    const link = linkFor(req, res);
    if (!link) return;
    db.prepare('UPDATE share_link SET open_count = open_count + 1 WHERE id = ?').run(link.id);
    res.json(payload(link));
  });

  // Group lookup for a new forecast: the ledger and the full group list, by code or name.
  publicRouter.get('/:token/groups', (req, res) => {
    const link = linkFor(req, res, 'report');
    if (!link) return;
    const keyword = String(req.query.q || '').trim();
    if (keyword.length < 2) return res.json([]);
    const like = `%${keyword.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = db.prepare(
      `SELECT group_code, MAX(group_name) AS group_name FROM leased_line
       WHERE COALESCE(group_code, '') <> '' AND (group_code LIKE ? ESCAPE '\\' OR group_name LIKE ? ESCAPE '\\') GROUP BY group_code
       UNION
       SELECT group_code, group_name FROM group_directory
       WHERE (group_code LIKE ? ESCAPE '\\' OR group_name LIKE ? ESCAPE '\\') AND group_code NOT IN (SELECT group_code FROM leased_line WHERE group_code IS NOT NULL)
       ORDER BY group_code LIMIT 20`
    ).all(like, like, like, like);
    res.json(rows);
  });

  publicRouter.post('/:token/lines/:id', (req, res) => {
    const link = linkFor(req, res, 'ledger');
    if (!link) return;
    const id = Number(req.params.id);
    const line = Number.isSafeInteger(id) ? db.prepare('SELECT id, manager_name, group_product_code FROM leased_line WHERE id = ?').get(id) : null;
    // Another manager's line reads as missing: the link says nothing about lines outside it.
    if (!line || line.manager_name !== link.manager_name) return res.status(404).json({ error: '这条专线不在这个链接的范围内' });
    const body = {};
    for (const field of fillFields) {
      if (!Object.hasOwn(req.body || {}, field)) continue;
      const value = req.body[field] === null ? '' : String(req.body[field]).trim();
      if (value.length > maxText) return res.status(400).json({ error: `每项内容不能超过 ${maxText} 字` });
      if (dateFields.includes(field) && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return res.status(400).json({ error: '日期格式不正确' });
      if (field === 'actual_monthly_fee' && value && !(Number(value) >= 0)) return res.status(400).json({ error: '实际月资费须为不小于 0 的数字' });
      body[field] = value;
    }
    const result = updateLine(id, body, { fields: fillFields, by: actor(link), source: 'share' });
    if (result.status === 200 && result.changes.length) {
      record(req, link, 'ledger', id, `专线 ${line.group_product_code || id}：${result.changes.map((change) => `${fieldLabels[change.field] || change.field} ${change.from ?? '空'} → ${change.to ?? '空'}`).join('；')}`);
    }
    if (result.status !== 200) return res.status(result.status).json(result.json);
    res.json({ line: linesOf(link.manager_name).find((item) => item.id === id) ?? null, changed: result.changes.length });
  });

  publicRouter.post('/:token/forecasts/:id/progress', (req, res) => {
    const link = linkFor(req, res, 'progress');
    if (!link) return;
    const id = Number(req.params.id);
    const forecast = Number.isSafeInteger(id) ? db.prepare('SELECT id, manager_name, group_name, landed_count FROM kpi_forecast WHERE id = ?').get(id) : null;
    if (!forecast || forecast.manager_name !== link.manager_name) return res.status(404).json({ error: '这条商机不在这个链接的范围内' });
    const result = kpi().addProgress(id, { note: req.body?.note, landed_count: req.body?.landed_count }, actor(link));
    if (result.status === 201) {
      const landed = result.json.landed_count !== forecast.landed_count ? `；已落地 ${forecast.landed_count} → ${result.json.landed_count}` : '';
      record(req, link, 'progress', id, `商机 ${forecast.group_name}：${String(req.body?.note).trim()}${landed}`);
    }
    res.status(result.status).json(result.json);
  });

  publicRouter.post('/:token/forecasts', (req, res) => {
    const link = linkFor(req, res, 'report');
    if (!link) return;
    const body = req.body || {};
    if (String(body.group_name ?? '').length > maxText) return res.status(400).json({ error: `集团名称不能超过 ${maxText} 字` });
    const result = kpi().createForecast({
      group_code: body.group_code, group_name: body.group_name, product_type: body.product_type, kind: body.kind,
      year: body.year, month: body.month, line_count: body.line_count, confidence: body.confidence
    }, actor(link), link.manager_name);
    if (result.status === 201) {
      const made = result.json;
      record(req, link, 'report', made.id, `上报${made.kind === 'cancelled' ? '预计销户' : '预计新增'}：${made.group_name}（${made.group_code}）${made.product_type} ${made.line_count} 条，${made.year}年${made.month}月`);
    }
    res.status(result.status).json(result.json);
  });

  /**
   * For another message that carries a link (the arrears summary): make one, then either record
   * where it went or take it back when the message certainly did not go out.
   */
  const forMail = {
    create: (input, username) => makeLinkFor(input, username),
    discard: (id) => db.prepare('DELETE FROM share_link WHERE id = ? AND submit_count = 0').run(id),
    sent: (id, recipient, { username = '', source = '', via = '' } = {}) => {
      const link = db.prepare('SELECT * FROM share_link WHERE id = ?').get(id);
      if (!link) return;
      db.prepare('UPDATE share_link SET sent_to = ?, sent_at = ? WHERE id = ?').run(recipient, new Date().toISOString(), id);
      logEvent('share_created', { username, source, detail: `${link.manager_name} · ${JSON.parse(link.scopes).map((key) => shareScopes[key]).join('、')} · 随${via}发送至 ${recipient}` });
    },
    scopeLabels: shareScopes,
    base: (fallback) => linkBase(fallback)
  };

  return { adminRouter, publicRouter, forMail };
}
