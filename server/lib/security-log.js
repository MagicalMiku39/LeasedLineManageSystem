import { db } from './db.js';
import { requestSource } from './client-cert.js';

export const securityLogRetentionDays = 180;

const pruneIntervalMs = 60 * 60 * 1000;
const defaultPageSize = 50;
const maxPageSize = 200;

const categories = {
  login: ['login_success', 'login_failed', 'login_locked'],
  account: ['password_changed', 'password_change_failed'],
  code: ['code_failed', 'code_locked', 'code_reused'],
  cert: ['ca_created', 'port_changed', 'cert_issued', 'cert_revoked', 'fill_port_changed'],
  backup: ['backup_created', 'backup_downloaded', 'backup_restored'],
  share: ['share_created', 'share_revoked', 'share_submitted', 'share_opened', 'share_opened_new', 'share_opened_many', 'share_bad_token', 'share_blocked', 'share_denied']
};

db.exec(`
CREATE TABLE IF NOT EXISTS security_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  username TEXT,
  source TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_security_log_at ON security_log(at);
`);

let lastPrune = 0;

export function pruneSecurityLog(now = Date.now()) {
  const cutoff = new Date(now - securityLogRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM security_log WHERE at < ?').run(cutoff);
  lastPrune = now;
}

/**
 * Records a security event. Never takes passwords or codes, and a failure to write must not
 * block a login or a certificate operation.
 */
export function logSecurityEvent(event, { username = '', source = '', detail = '' } = {}) {
  try {
    const now = Date.now();
    if (now - lastPrune > pruneIntervalMs) pruneSecurityLog(now);
    db.prepare('INSERT INTO security_log (at, event, username, source, detail) VALUES (?, ?, ?, ?, ?)')
      .run(new Date(now).toISOString(), event, username, source, detail);
  } catch (error) {
    console.error(`Security log write failed: ${error.message}`);
  }
}

/** Newest first. `before` is the id of the last row already shown. */
export function listSecurityEvents({ category, before, limit } = {}) {
  const size = Math.min(Math.max(Number(limit) || defaultPageSize, 1), maxPageSize);
  const where = [];
  const params = [];
  const events = categories[category];
  if (events) {
    where.push(`event IN (${events.map(() => '?').join(', ')})`);
    params.push(...events);
  }
  if (Number.isSafeInteger(Number(before)) && Number(before) > 0) {
    where.push('id < ?');
    params.push(Number(before));
  }
  const rows = db.prepare(
    `SELECT id, at, event, username, source, detail FROM security_log
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY id DESC LIMIT ?`
  ).all(...params, size + 1);
  return { rows: rows.slice(0, size), hasMore: rows.length > size, retentionDays: securityLogRetentionDays };
}

// Events that deserve a look: someone failing to get in, or a link being used oddly.
export const alertEvents = [
  'login_failed', 'login_locked', 'code_failed', 'code_locked', 'code_reused', 'password_change_failed',
  'share_bad_token', 'share_blocked', 'share_denied', 'share_opened_many'
];

/**
 * The alert events since this user's previous login (the one before the current session), so
 * signing in shows what happened while they were away. With no earlier login, everything kept.
 */
export function securitySummary(username) {
  const logins = db.prepare("SELECT id, at FROM security_log WHERE event = 'login_success' AND username = ? ORDER BY id DESC LIMIT 2").all(username);
  const previous = logins[1] ?? null;
  const items = db.prepare(
    `SELECT event, COUNT(*) AS count, MAX(id) AS latest FROM security_log
     WHERE id > ? AND event IN (${alertEvents.map(() => '?').join(', ')}) GROUP BY event`
  ).all(previous?.id ?? 0, ...alertEvents);
  const order = new Map(alertEvents.map((event, index) => [event, index]));
  items.sort((a, b) => order.get(a.event) - order.get(b.event));
  return {
    since: previous?.at ?? null,
    latestId: items.reduce((max, item) => Math.max(max, item.latest), 0),
    total: items.reduce((sum, item) => sum + item.count, 0),
    items: items.map(({ event, count }) => ({ event, count }))
  };
}

export function securitySummaryHandler(req, res, username) {
  // Like the log itself, not for a phone on the certificate port.
  if (requestSource(req).startsWith('cert:')) {
    res.json({ since: null, latestId: 0, total: 0, items: [] });
    return;
  }
  res.json(securitySummary(username));
}

// The log names company addresses and devices, so a phone on the certificate port cannot read it.
export function securityLogHandler(req, res) {
  if (requestSource(req).startsWith('cert:')) {
    res.status(403).json({ error: '通过设备证书端口登录时不能查看安全日志，请从公司网络访问' });
    return;
  }
  res.json(listSecurityEvents(req.query));
}
