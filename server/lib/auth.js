import crypto from 'node:crypto';
import { db, nowIso } from './db.js';

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
`);

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

export function loginAuth({ username, password, code }) {
  const user = db.prepare('SELECT * FROM auth_user WHERE username = ?').get(String(username || '').trim());
  if (!user) throw new Error('账号、密码或验证码错误');
  const { hash } = hashPassword(password || '', user.password_salt);
  if (!timingSafeEqualText(hash, user.password_hash)) throw new Error('账号、密码或验证码错误');
  if (!verifyTotp(user.totp_secret, code)) throw new Error('账号、密码或验证码错误');

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
