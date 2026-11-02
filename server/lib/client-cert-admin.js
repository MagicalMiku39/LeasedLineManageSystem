import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClientCertError, normalizeSerial } from './client-cert.js';

export { ClientCertError };

const windowsOpenssl = ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe'];
const syncedFolder = /onedrive|dropbox|坚果云|icloud|google drive/i;

export const defaultClientCertSettings = { enabled: false, port: 8443, defaultDays: 365 };

function findOpenssl() {
  const candidates = [process.env.OPENSSL_BIN, 'openssl', ...(process.platform === 'win32' ? windowsOpenssl : [])].filter(Boolean);
  const found = candidates.find((bin) => spawnSync(bin, ['version'], { stdio: 'ignore' }).status === 0);
  if (!found) throw new ClientCertError('服务器上找不到 openssl，请安装后重试，或用 OPENSSL_BIN 指定路径');
  return found;
}

// Paths stay relative to the certificate folder so non-ASCII parent folders never reach openssl.
function runOpenssl(bin, paths, args, env = {}) {
  const result = spawnSync(bin, args, { cwd: paths.dir, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new ClientCertError(`openssl ${args[0]} 失败：${result.stderr || result.error?.message || ''}`);
  return result.stdout;
}

function protect(file) {
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function readRegistry(paths) {
  if (!existsSync(paths.registry)) throw new ClientCertError('还没有创建证书机构');
  return JSON.parse(readFileSync(paths.registry, 'utf8'));
}

function requestConfig(commonName, extensions) {
  return `[req]
prompt = no
utf8 = yes
string_mask = utf8only
distinguished_name = dn

[dn]
CN = ${commonName}

${extensions}`;
}

export function caExists(paths) {
  return existsSync(paths.caKey) && existsSync(paths.caCert) && existsSync(paths.registry);
}

export function initCa(paths) {
  if (existsSync(paths.caKey)) throw new ClientCertError(`证书机构已存在，不会覆盖：${paths.caKey}`);
  // ca.key can sign new device certificates, so it must never reach a cloud-synced folder.
  if (syncedFolder.test(paths.dir)) {
    throw new ClientCertError(`证书目录在云同步文件夹内（${paths.dir}），ca.key 会被同步到云端。请用 CLIENT_CERT_DIR 指定其他目录`);
  }
  const bin = findOpenssl();
  mkdirSync(paths.dir, { recursive: true });
  if (process.platform !== 'win32') chmodSync(paths.dir, 0o700);
  // Anyone who connects to the port can read this name, so it says nothing about the system.
  writeFileSync(join(paths.dir, 'ca.cnf'), requestConfig('Device CA', `[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
`));
  try {
    runOpenssl(bin, paths, ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'ca.key']);
    protect(paths.caKey);
    runOpenssl(bin, paths, ['req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', '3650', '-config', 'ca.cnf', '-extensions', 'v3_ca', '-out', 'ca.crt']);
  } finally {
    rmSync(join(paths.dir, 'ca.cnf'), { force: true });
  }
  writeJson(paths.registry, { certificates: [] });
}

/** The p12 and its password are returned, never stored: they exist only in this response. */
export function issueCertificate(paths, { name, days, issuedBy = '' }) {
  const deviceName = String(name || '').trim();
  if (!/^[\p{L}\p{N} _-]{1,40}$/u.test(deviceName)) throw new ClientCertError('设备名须为 1–40 个文字、数字、空格、下划线或短横线');
  if (!Number.isSafeInteger(days) || days <= 0 || days > 3650) throw new ClientCertError('有效天数须为 1–3650 的整数');
  const registry = readRegistry(paths);
  if (registry.certificates.some((item) => item.name === deviceName && !item.revokedAt)) throw new ClientCertError(`设备名已在使用：${deviceName}`);
  const bin = findOpenssl();

  const bytes = crypto.randomBytes(16);
  bytes[0] = (bytes[0] & 0x6f) | 0x10; // Positive, with no leading zero to lose in formatting.
  const serial = bytes.toString('hex').toUpperCase();
  const password = crypto.randomBytes(15).toString('base64url');

  const work = mkdtempSync(join(paths.dir, 'work-'));
  const relative = work.slice(paths.dir.length + 1);
  const inWork = (file) => `${relative}/${file}`;
  try {
    writeFileSync(join(work, 'req.cnf'), requestConfig(deviceName, `[v3_client]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = clientAuth
`));
    runOpenssl(bin, paths, ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', inWork('device.key')]);
    runOpenssl(bin, paths, ['req', '-new', '-key', inWork('device.key'), '-config', inWork('req.cnf'), '-out', inWork('device.csr')]);
    runOpenssl(bin, paths, ['x509', '-req', '-in', inWork('device.csr'), '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', `0x${serial}`,
      '-days', String(days), '-sha256', '-extfile', inWork('req.cnf'), '-extensions', 'v3_client', '-out', inWork('device.crt')]);
    // These older algorithms are the ones every Android version can read; the random password protects the file.
    runOpenssl(bin, paths, ['pkcs12', '-export', '-inkey', inWork('device.key'), '-in', inWork('device.crt'), '-certfile', 'ca.crt', '-name', 'device',
      '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1', '-passout', 'env:LEDGER_P12_PASSWORD', '-out', inWork('device.p12')],
    { LEDGER_P12_PASSWORD: password });
    const notAfter = runOpenssl(bin, paths, ['x509', '-in', inWork('device.crt'), '-noout', '-enddate']).trim().replace('notAfter=', '');
    const certificate = {
      name: deviceName,
      serial,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(notAfter).toISOString(),
      issuedBy,
      revokedAt: null
    };
    const p12 = readFileSync(join(work, 'device.p12'));
    registry.certificates.push(certificate);
    writeJson(paths.registry, registry);
    return { certificate, p12, password };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function listCertificates(paths) {
  const now = new Date().toISOString();
  return readRegistry(paths).certificates.map((item) => ({
    ...item,
    state: item.revokedAt ? 'revoked' : item.expiresAt < now ? 'expired' : 'active'
  }));
}

/** Matches a serial number or the name of a certificate still in use. */
export function revokeCertificate(paths, target, revokedBy = '') {
  const registry = readRegistry(paths);
  const serial = normalizeSerial(target);
  const match = registry.certificates.find((item) => !item.revokedAt
    && (item.name === target || (serial && normalizeSerial(item.serial) === serial)));
  if (!match) throw new ClientCertError(`没有找到有效的证书：${target}`);
  match.revokedAt = new Date().toISOString();
  match.revokedBy = revokedBy;
  writeJson(paths.registry, registry);
  return match;
}

// An unreadable file means closed: the port only opens when the saved settings say so.
export function readClientCertSettings(paths) {
  try {
    return { ...defaultClientCertSettings, ...JSON.parse(readFileSync(paths.settings, 'utf8')) };
  } catch {
    return { ...defaultClientCertSettings };
  }
}

export function writeClientCertSettings(paths, settings) {
  mkdirSync(paths.dir, { recursive: true });
  writeJson(paths.settings, settings);
}
