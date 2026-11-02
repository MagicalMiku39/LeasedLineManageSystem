import crypto from 'node:crypto';
import { db, nowIso } from './db.js';
import { logSecurityEvent } from './security-log.js';

const issuer = 'LeasedLineManageSystem';
const sessionDays = 7;
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

db.exec(`
CREATE TABLE IF NOT EXISTS auth_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  totp_secret TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES auth_user(id)
);

CREATE TABLE IF NOT EXISTS auth_attempt (
  attempt_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);
`);

const maxFailures = 5;
const lockMinutes = 15;
const lockMs = lockMinutes * 60 * 1000;
// Compared against when the account does not exist, so its absence takes just as long to report.
const unknownUserSalt = 'unknown-user';

/** Too many wrong passwords or codes from one source; `status` is the HTTP status to answer with. */
export class AuthLockedError extends Error {
  constructor(minutes) {
    super(`尝试次数过多，请 ${minutes} 分钟后再试`);
    this.status = 429;
  }
}

// Counted per source, not per account alone: someone holding a stolen device certificate can
// use up only that certificate's tries, and cannot lock the administrator out of the page where
// the certificate gets revoked.
function attemptKey(username, source) {
  return `${String(username || '').trim()}|${source}`;
}

function assertNotLocked(key) {
  const row = db.prepare('SELECT locked_until FROM auth_attempt WHERE attempt_key = ?').get(key);
  const remaining = row?.locked_until ? new Date(row.locked_until).getTime() - Date.now() : 0;
  if (remaining > 0) throw new AuthLockedError(Math.ceil(remaining / 60000));
}

function recordFailure(key) {
  const now = Date.now();
  db.prepare('DELETE FROM auth_attempt WHERE updated_at < ?').run(new Date(now - 24 * 60 * 60 * 1000).toISOString());
  const row = db.prepare('SELECT failures, updated_at FROM auth_attempt WHERE attempt_key = ?').get(key);
  const recent = row && now - new Date(row.updated_at).getTime() < lockMs;
  const failures = recent ? row.failures + 1 : 1;
  const lockedUntil = failures >= maxFailures ? new Date(now + lockMs).toISOString() : null;
  db.prepare(
    `INSERT INTO auth_attempt (attempt_key, failures, locked_until, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(attempt_key) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at`
  ).run(key, failures, lockedUntil, new Date(now).toISOString());
  return Boolean(lockedUntil);
}

function clearFailures(key) {
  db.prepare('DELETE FROM auth_attempt WHERE attempt_key = ?').run(key);
}

function base32Encode(buffer) {
  let bits = '';
  let value = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  for (let index = 0; index < bits.length; index += 5) {
    const chunk = bits.slice(index, index + 5).padEnd(5, '0');
    value += base32Alphabet[Number.parseInt(chunk, 2)];
  }
  return value;
}

function base32Decode(secret) {
  const clean = String(secret).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const value = base32Alphabet.indexOf(char);
    if (value < 0) continue;
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

function verifyTotp(secret, code) {
  const cleanCode = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleanCode)) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let drift = -1; drift <= 1; drift += 1) {
    if (timingSafeEqualText(hotp(secret, counter + drift), cleanCode)) return true;
  }
  return false;
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

function makeSessionCookie(token, expiresAt) {
  const secure = process.env.AUTH_COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `ledger_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure}`;
}

export function authStatus() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM auth_user').get().count;
  return { configured: count > 0, sessionDays };
}

export function setupAuth({ username, password }) {
  if (authStatus().configured) throw new Error('管理员账号已创建');
  if (!username || username.trim().length < 3) throw new Error('账号至少需要 3 个字符');
  if (!password || password.length < 8) throw new Error('密码至少需要 8 个字符');

  const secret = base32Encode(crypto.randomBytes(20));
  const { salt, hash } = hashPassword(password);
  const normalizedUsername = username.trim();
  db.prepare(
    `INSERT INTO auth_user (username, password_hash, password_salt, totp_secret, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(normalizedUsername, hash, salt, secret, nowIso(), nowIso());

  const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(normalizedUsername)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return { username: normalizedUsername, totpSecret: secret, otpauthUrl };
}

export function loginAuth({ username, password, code }, source = '') {
  const key = attemptKey(username, source);
  assertNotLocked(key);
  const user = db.prepare('SELECT * FROM auth_user WHERE username = ?').get(String(username || '').trim());
  const { hash } = hashPassword(password || '', user?.password_salt || unknownUserSalt);
  if (!user || !timingSafeEqualText(hash, user.password_hash) || !verifyTotp(user.totp_secret, code)) {
    const locked = recordFailure(key);
    // An unknown name is not written down: people sometimes type their password in that box.
    const entry = { username: user?.username || '', source, detail: user ? '' : '账号不存在' };
    logSecurityEvent('login_failed', entry);
    if (locked) logSecurityEvent('login_locked', { ...entry, detail: `连续错误 ${maxFailures} 次，锁定 ${lockMinutes} 分钟` });
    throw new Error('账号、密码或验证码错误');
  }
  clearFailures(key);
  logSecurityEvent('login_success', { username: user.username, source });

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);
  db.prepare(
    `INSERT INTO auth_session (user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(user.id, hashToken(token), expiresAt.toISOString(), nowIso());

  return {
    user: { username: user.username },
    cookie: makeSessionCookie(token, expiresAt)
  };
}

/** Asks for the authenticator again before a sensitive action, on top of the login session. */
export function verifyUserCode(username, code, source = '') {
  const key = attemptKey(username, source);
  assertNotLocked(key);
  const user = db.prepare('SELECT totp_secret FROM auth_user WHERE username = ?').get(String(username || ''));
  if (!user || !verifyTotp(user.totp_secret, code)) {
    const locked = recordFailure(key);
    logSecurityEvent('code_failed', { username: String(username || ''), source });
    if (locked) logSecurityEvent('code_locked', { username: String(username || ''), source, detail: `连续错误 ${maxFailures} 次，锁定 ${lockMinutes} 分钟` });
    return false;
  }
  clearFailures(key);
  return true;
}

export function logoutAuth(req, res) {
  const token = getCookie(req, 'ledger_session');
  if (token) {
    db.prepare('DELETE FROM auth_session WHERE token_hash = ?').run(hashToken(token));
  }
  res.setHeader('Set-Cookie', 'ledger_session=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
}

export function currentUser(req) {
  const token = getCookie(req, 'ledger_session');
  if (!token) return null;
  const session = db.prepare(
    `SELECT s.id, s.expires_at, u.username
     FROM auth_session s
     JOIN auth_user u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  ).get(hashToken(token));
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM auth_session WHERE id = ?').run(session.id);
    return null;
  }
  return { username: session.username };
}

export function requireAuth(req, res, next) {
  if (currentUser(req)) {
    next();
    return;
  }
  res.status(401).json({ error: '未登录' });
}
