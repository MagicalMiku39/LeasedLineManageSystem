import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { createKpiRouter } from '../server/lib/kpi.js';
import XLSX from '../server/lib/xlsx.js';

const tempDir = mkdtempSync(join(tmpdir(), 'ledger-tests-'));
process.env.LEDGER_DB_PATH = join(tempDir, 'test.db');

const { db, makeBatchId, nowIso } = await import('../server/lib/db.js');
const auth = await import('../server/lib/auth.js');
const securityLog = await import('../server/lib/security-log.js');
const importer = await import('../server/lib/import-excel.js');
const { excelHeaders } = await import('../server/lib/field-map.js');
const serverModule = await import('../server/index.js');

const listener = serverModule.app.listen(0, '127.0.0.1');
await new Promise((resolve) => listener.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${listener.address().port}`;
let sessionCookie = '';

after(async () => {
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function totp(secret, time = Date.now()) {
  db.prepare('UPDATE auth_user SET totp_last_step = NULL').run();
  return totpRaw(secret, time);
}

function totpRaw(secret, time = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  const counter = Math.floor(time / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(buffer).digest();
  const offset = hmac.at(-1) & 0xf;
  const value = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(value % 1000000).padStart(6, '0');
}

async function request(path, options = {}, authenticated = true) {
  const headers = new Headers(options.headers || {});
  if (authenticated && sessionCookie) headers.set('Cookie', sessionCookie);
  if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
    options = { ...options, body: JSON.stringify(options.body) };
  }
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}

function writeWorkbook(path, values = {}) {
  const row = Object.fromEntries(excelHeaders.map((header) => [header, '']));
  Object.assign(row, values);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([row]), 'Sheet1');
  XLSX.writeFile(workbook, path);
}

test('server helper functions cover coercion, periods, sorting and filters', () => {
  assert.equal(serverModule.numberOrNull('12.5'), 12.5);
  assert.equal(serverModule.numberOrNull(''), null);
  assert.equal(serverModule.numberOrNull('bad'), null);
  assert.deepEqual(serverModule.parseMultiValue(' A | | B '), ['A', 'B']);
  assert.deepEqual(serverModule.parseMultiValue(''), []);
  assert.equal(serverModule.isKpiMode({}), true);
  assert.equal(serverModule.isKpiMode({ kpiMode: '0' }), false);
  assert.equal(serverModule.leasedLineSource({ kpiMode: '0' }), 'leased_line');
  assert.deepEqual(serverModule.monthRange('2024-12'), {
    month: '2024-12', monthStart: '2024-12-01', nextMonthStart: '2025-01-01'
  });
  assert.deepEqual(serverModule.periodFromMonth('2024-04'), {
    month: '2024-04', year: 2024, quarter: 2,
    monthStart: '2024-04-01', nextMonthStart: '2024-05-01',
    quarterStart: '2024-04-01', nextQuarterStart: '2024-07-01',
    yearStart: '2024-01-01', nextYearStart: '2025-01-01'
  });
  assert.equal(serverModule.repairMojibake('ä¸­æ–‡'), '中文');
  assert.equal(serverModule.repairMojibake('正常'), '正常');
  assert.equal(serverModule.normalizeUploadedFilename('ä¸­æ–‡.xlsx'), '中文.xlsx');

  const order = serverModule.ledgerOrderBy({ sortBy: 'ledger_status', sortDirection: 'asc' });
  assert.equal(order.sortBy, 'ledger_status');
  assert.equal(order.sortDirection, 'asc');
  assert.match(order.sql, /COALESCE/);
  assert.equal(serverModule.ledgerOrderBy({ sortBy: 'DROP TABLE' }).sortBy, 'updated_at');

  const where = serverModule.buildLedgerWhere({
    kpiMode: '0', keyword: ' Acme ', region: 'East|West', groupCode: ' G ',
    zeroBilling: '是', contractEndFrom: '2024-01-01', contractEndTo: '2024-12-31',
    statFilter: 'stoppedInMonth', statMonth: '2024-04'
  });
  assert.match(where.sql, /group_name LIKE/);
  assert.match(where.sql, /region_name IN \(\?, \?\)/);
  assert.match(where.sql, /status_time >= \?/);
  assert.ok(where.params.includes('%Acme%'));
  assert.ok(where.params.includes('East'));
  assert.ok(where.params.includes('2024-04-01'));
});

test('database and import helpers normalize values and generate identifiers', () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T/);
  assert.match(makeBatchId(), /^BATCH-\d{14}-[a-z0-9]{6}$/);
  assert.equal(importer.normalizeValue('  text  '), 'text');
  assert.equal(importer.normalizeValue('  '), null);
  assert.equal(importer.normalizeValue(new Date('2024-01-02T03:04:05Z')), '2024-01-02 03:04:05');
  assert.equal(importer.normalizeAmount('1,234.50'), 1234.5);
  assert.equal(importer.normalizeAmount('not-a-number'), null);
  assert.throws(() => importer.validateHeaders(['集团编码']), /Excel 缺少必要字段/);
  assert.doesNotThrow(() => importer.validateHeaders(excelHeaders));
  const record = importer.rowToRecord({ '总欠费': '2,000', '活动套餐资费': '99.5', '产品状态名称': '正常在用' });
  assert.equal(record.total_arrears, 2000);
  assert.equal(record.package_fee, 99.5);
  assert.equal(record.ledger_status, '正常在用');
});

test('authentication setup, login, session lookup and logout are enforced', async () => {
  assert.deepEqual(auth.authStatus(), { configured: false, sessionDays: 7 });
  assert.throws(() => auth.setupAuth({ username: 'ab', password: 'password1' }), /账号至少/);
  assert.throws(() => auth.setupAuth({ username: 'admin', password: 'short' }), /密码至少/);

  const setupResponse = await request('/api/auth/setup', {
    method: 'POST', body: { username: ' admin ', password: 'password1' }
  }, false);
  assert.equal(setupResponse.status, 200);
  const setup = await setupResponse.json();
  assert.equal(setup.username, 'admin');
  assert.match(setup.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.throws(() => auth.setupAuth({ username: 'other', password: 'password1' }), /管理员账号已创建/);

  const denied = await request('/api/auth/login', {
    method: 'POST', body: { username: 'admin', password: 'wrongpass', code: '000000' }
  }, false);
  assert.equal(denied.status, 401);

  const login = await request('/api/auth/login', {
    method: 'POST', body: { username: 'admin', password: 'password1', code: totp(setup.totpSecret) }
  }, false);
  assert.equal(login.status, 200);
  sessionCookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(sessionCookie, /^ledger_session=/);
  assert.deepEqual((await login.json()).user, { username: 'admin' });

  const status = await request('/api/auth/status');
  assert.deepEqual((await status.json()).user, { username: 'admin' });
  const unauthenticated = await request('/api/health', {}, false);
  assert.equal(unauthenticated.status, 401);
});

test('repeated failures lock only the source they came from, then expire', async () => {
  const secret = db.prepare('SELECT totp_secret FROM auth_user WHERE username = ?').get('admin').totp_secret;
  const right = () => ({ username: 'admin', password: 'password1', code: totp(secret) });
  const wrong = { username: 'admin', password: 'wrongpass', code: '000000' };
  db.exec('DELETE FROM auth_attempt');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(() => auth.loginAuth(wrong, 'ip:attacker'), /账号、密码或验证码错误/);
  }
  assert.throws(() => auth.loginAuth(right(), 'ip:attacker'), { status: 429, message: /尝试次数过多/ });
  assert.equal(auth.loginAuth(right(), 'ip:company').user.username, 'admin', 'another source can still log in');

  // A correct login clears earlier mistakes.
  for (let attempt = 0; attempt < 4; attempt += 1) assert.throws(() => auth.loginAuth(wrong, 'ip:typo'));
  auth.loginAuth(right(), 'ip:typo');
  for (let attempt = 0; attempt < 4; attempt += 1) assert.throws(() => auth.loginAuth(wrong, 'ip:typo'));
  assert.equal(auth.loginAuth(right(), 'ip:typo').user.username, 'admin');

  // Unknown accounts answer the same way and lock too.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(() => auth.loginAuth({ ...wrong, username: 'nobody' }, 'ip:scan'), /账号、密码或验证码错误/);
  }
  assert.throws(() => auth.loginAuth({ ...wrong, username: 'nobody' }, 'ip:scan'), { status: 429 });

  // The extra authenticator check shares the limit.
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(auth.verifyUserCode('admin', '000000', 'cert:AA'), false);
  assert.throws(() => auth.verifyUserCode('admin', totp(secret), 'cert:AA'), { status: 429 });
  assert.equal(auth.verifyUserCode('admin', totp(secret), 'ip:company'), true);

  // The lock runs out on its own, and the count starts over.
  const past = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  db.prepare('UPDATE auth_attempt SET locked_until = ?, updated_at = ?').run(past, past);
  assert.throws(() => auth.loginAuth(wrong, 'ip:attacker'), /账号、密码或验证码错误/);
  assert.equal(db.prepare('SELECT failures FROM auth_attempt WHERE attempt_key = ?').get('admin|ip:attacker').failures, 1);
  assert.equal(auth.loginAuth(right(), 'ip:attacker').user.username, 'admin');

  // Over HTTP the lock answers 429.
  db.exec('DELETE FROM auth_attempt');
  const post = (body) => request('/api/auth/login', { method: 'POST', body }, false);
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await post(wrong)).status, 401);
  assert.equal((await post(right())).status, 429);
  db.exec('DELETE FROM auth_attempt');
});

test('security log records logins and locks, never secrets, and stays out of reach of device certificates', async () => {
  const secret = db.prepare('SELECT totp_secret FROM auth_user WHERE username = ?').get('admin').totp_secret;
  db.exec('DELETE FROM auth_attempt; DELETE FROM security_log;');
  const events = (category) => securityLog.listSecurityEvents({ category }).rows;

  auth.loginAuth({ username: 'admin', password: 'password1', code: totp(secret) }, 'ip:10.0.0.1');
  assert.throws(() => auth.loginAuth({ username: 'admin', password: 'typed-secret', code: '000000' }, 'ip:10.0.0.2'));
  assert.throws(() => auth.loginAuth({ username: 'my-password-in-the-wrong-box', password: 'x', code: '1' }, 'ip:10.0.0.3'));

  const [unknown, failed, success] = events('login');
  assert.deepEqual([success.event, success.username, success.source], ['login_success', 'admin', 'ip:10.0.0.1']);
  assert.deepEqual([failed.event, failed.username, failed.source], ['login_failed', 'admin', 'ip:10.0.0.2']);
  assert.deepEqual([unknown.username, unknown.detail], ['', '账号不存在'], 'an unknown name is not written down');
  const stored = JSON.stringify(db.prepare('SELECT * FROM security_log').all());
  assert.ok(!stored.includes('typed-secret') && !stored.includes('my-password-in-the-wrong-box') && !stored.includes('password1'));

  // A lock is recorded once, and attempts while locked add nothing.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(() => auth.loginAuth({ username: 'admin', password: 'wrong', code: '0' }, 'ip:10.0.0.9'));
  }
  const before = events('login').length;
  assert.throws(() => auth.loginAuth({ username: 'admin', password: 'wrong', code: '0' }, 'ip:10.0.0.9'), { status: 429 });
  assert.equal(events('login').length, before);
  assert.equal(events('login').filter((row) => row.event === 'login_locked').length, 1);

  for (let attempt = 0; attempt < 5; attempt += 1) auth.verifyUserCode('admin', '000000', 'cert:AB');
  assert.equal(events('code').filter((row) => row.event === 'code_failed').length, 5);
  assert.equal(events('code').filter((row) => row.event === 'code_locked').length, 1);
  assert.equal(events('cert').length, 0);

  // Paging goes newest first without gaps.
  const all = securityLog.listSecurityEvents({ limit: 500 }).rows;
  const first = securityLog.listSecurityEvents({ limit: 3 });
  assert.equal(first.hasMore, true);
  const next = securityLog.listSecurityEvents({ limit: 3, before: first.rows[2].id });
  assert.deepEqual([...first.rows, ...next.rows].map((row) => row.id), all.slice(0, 6).map((row) => row.id));

  const response = await request('/api/settings/security-log?category=login&limit=2');
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.rows.length, 2);
  assert.equal(page.retentionDays, 180);
  assert.equal((await request('/api/settings/security-log', {}, false)).status, 401);

  let status = 0;
  securityLog.securityLogHandler(
    { query: {}, socket: { getPeerCertificate: () => ({ serialNumber: 'AB' }) } },
    { status(code) { status = code; return this; }, json() {} }
  );
  assert.equal(status, 403, 'a phone on the certificate port cannot read the log');

  // Old entries are removed.
  db.prepare('UPDATE security_log SET at = ? WHERE id = ?').run(new Date(Date.now() - 181 * 86400000).toISOString(), all[0].id);
  securityLog.pruneSecurityLog();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM security_log WHERE id = ?').get(all[0].id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM security_log').get().count, all.length - 1);
  db.exec('DELETE FROM auth_attempt');
});

test('ledger upload refuses oversized files with a readable error and keeps nothing', async () => {
  const uploads = join(process.cwd(), 'uploads');
  const before = readdirSync(uploads).length;
  const form = new FormData();
  form.append('file', new Blob([Buffer.alloc(32 * 1024 * 1024 + 1)]), 'big.xlsx');
  const response = await request('/api/import', { method: 'POST', body: form });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /不能超过 32 MB/);
  assert.equal(readdirSync(uploads).length, before);

  const unauthenticated = new FormData();
  unauthenticated.append('file', new Blob(['x']), 'a.xlsx');
  assert.equal((await request('/api/import', { method: 'POST', body: unauthenticated }, false)).status, 401);
});

test('the Excel library is the patched release, reads files, and keeps codes and legacy text intact', () => {
  assert.ok(XLSX.version.startsWith('0.20.'), 'the patched SheetJS release, not the one published on npm');

  const file = join(tempDir, 'round-trip.xlsx');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([{ 集团编码: '00123', 金额: 0, 文本日期: '2026-11-02', 空: '' }]), 'S');
  XLSX.writeFile(book, file);
  const back = XLSX.readFile(file, { cellDates: true });
  assert.deepEqual(XLSX.utils.sheet_to_json(back.Sheets.S, { defval: '', raw: false }), [{ 集团编码: '00123', 金额: '0', 文本日期: '2026-11-02', 空: '' }]);

  // Older files store text in a codepage; without its tables, GBK bytes for 集团 come back garbled.
  const gbk = XLSX.read(Buffer.from([0xbc, 0xaf, 0xcd, 0xc5]), { type: 'buffer', codepage: 936 });
  assert.deepEqual(XLSX.utils.sheet_to_json(gbk.Sheets[gbk.SheetNames[0]], { header: 1 }), [['集团']]);
});

test('Excel import inserts and updates rows while preserving blank package fee', () => {
  const path = join(tempDir, 'import.xlsx');
  writeWorkbook(path, {
    '集团编码': 'G001', '集团名称': 'Acme', '集团产品编码': 'GP001',
    '产品名称': '互联网专线', '产品状态名称': '正常在用', '客户经理名称': 'Alice',
    '开始时间': '2024-04-10', '活动套餐资费': '1,200', '总欠费': '50'
  });
  const inserted = importer.importExcel(path, 'import.xlsx');
  assert.deepEqual({ totalRows: inserted.totalRows, successRows: inserted.successRows, failedRows: inserted.failedRows, updatedRows: inserted.updatedRows }, {
    totalRows: 1, successRows: 1, failedRows: 0, updatedRows: 0
  });
  assert.equal(db.prepare('SELECT package_fee FROM leased_line WHERE group_product_code = ?').get('GP001').package_fee, 1200);

  writeWorkbook(path, {
    '集团编码': 'G001', '集团名称': 'Acme Updated', '集团产品编码': 'GP001',
    '产品名称': '互联网专线', '产品状态名称': '正常在用', '客户经理名称': 'Alice'
  });
  const updated = importer.importExcel(path, 'import.xlsx');
  assert.equal(updated.updatedRows, 1);
  const row = db.prepare('SELECT group_name, package_fee FROM leased_line WHERE group_product_code = ?').get('GP001');
  assert.equal(row.group_name, 'Acme Updated');
  assert.equal(row.package_fee, 1200);
});

test('protected ledger APIs cover list, edit, batch, stats, performance and export', async () => {
  db.prepare(`INSERT INTO leased_line
    (group_code, group_name, group_product_code, product_name, product_status_name, ledger_status,
     manager_name, start_time, status_time, package_fee, actual_monthly_fee, one_time_fee, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('G002', 'Beta', 'GP002', '传输专线', '停机', '停机', 'Bob', '2024-04-03', '2024-04-20', 300, 500, 50, nowIso());
  db.prepare(`INSERT INTO leased_line
    (group_code, group_name, group_product_code, product_name, product_status_name, ledger_status, manager_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('G003', 'Non KPI', 'GP003', '其他产品', '正常在用', '正常在用', 'Carol', nowIso());

  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const list = await request('/api/ledger?kpiMode=0&keyword=Beta&status=%E5%81%9C%E6%9C%BA&sortBy=group_name&sortDirection=asc&pageSize=10');
  const listData = await list.json();
  assert.equal(listData.total, 1);
  assert.equal(listData.rows[0].group_product_code, 'GP002');
  const id = listData.rows[0].id;

  const detail = await request(`/api/ledger/${id}`);
  assert.equal((await detail.json()).group_name, 'Beta');
  assert.equal((await request('/api/ledger/999999')).status, 404);

  const invalidPatch = await request(`/api/ledger/${id}`, { method: 'PATCH', body: { group_name: 'blocked' } });
  assert.equal(invalidPatch.status, 400);
  const patched = await request(`/api/ledger/${id}`, {
    method: 'PATCH', body: { actual_monthly_fee: '750.5', remark: 'reviewed' }
  });
  const patchedData = await patched.json();
  assert.equal(patchedData.actual_monthly_fee, 750.5);
  assert.equal(patchedData.remark, 'reviewed');

  const logs = await request(`/api/ledger/${id}/logs`);
  const logData = await logs.json();
  assert.deepEqual(new Set(logData.map((item) => item.field_name)), new Set(['actual_monthly_fee', 'remark']));
  assert.ok(logData.every((item) => item.change_source === 'manual'));

  assert.equal((await request('/api/ledger/batch', { method: 'PATCH', body: { ids: [], values: {} } })).status, 400);
  assert.equal((await request('/api/ledger/batch', { method: 'PATCH', body: { ids: [id], values: {} } })).status, 400);
  const batch = await request('/api/ledger/batch', {
    method: 'PATCH', body: { ids: [id, 999999], values: { project_name: 'Project X', one_time_fee: '80' } }
  });
  assert.equal((await batch.json()).updated, 2);

  const options = await request('/api/options');
  const optionsData = await options.json();
  assert.ok(optionsData.managers.includes('Bob'));
  assert.ok(optionsData.products.includes('其他产品'));

  const stats = await request('/api/stats?month=2024-04&kpiMode=1');
  const statsData = await stats.json();
  assert.equal(statsData.kpiMode, true);
  assert.equal(statsData.total, 2);
  assert.equal(statsData.stoppedInMonth, 1);
  assert.equal(statsData.expectedMonthlyBilling, 1950.5);
  assert.equal(statsData.expectedOneTimeBilling, 80);

  const performance = await request('/api/manager-performance?month=2024-04&managers=Bob&sort=monthScaleNet&kpiMode=1');
  const performanceData = await performance.json();
  assert.equal(performanceData.rows.length, 1);
  assert.equal(performanceData.rows[0].manager_name, 'Bob');
  assert.equal(performanceData.rows[0].month_added_count, 1);
  assert.equal(performanceData.rows[0].month_cancelled_count, 0);

  const imports = await request('/api/imports');
  assert.equal((await imports.json()).length, 2);
  const batchId = db.prepare('SELECT id FROM import_batch ORDER BY imported_at DESC LIMIT 1').get().id;
  const importRows = await request(`/api/imports/${batchId}/rows`);
  assert.equal((await importRows.json()).length, 1);

  const exported = await request('/api/ledger/export?kpiMode=0&keyword=Beta');
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /spreadsheetml/);
  const workbook = XLSX.read(Buffer.from(await exported.arrayBuffer()));
  const exportedRows = XLSX.utils.sheet_to_json(workbook.Sheets['台账导出']);
  assert.equal(exportedRows.length, 1);
  assert.equal(exportedRows[0]['集团名称'], 'Beta');
});

test('imports record what changed, keep the year net before and after, and notice lines that vanish', async () => {
  const path = join(tempDir, 'changes.xlsx');
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date());
  const line = (code, values = {}) => ({
    '集团编码': `G-${code}`, '集团名称': `集团${code}`, '集团产品编码': code, '产品名称': '互联网专线',
    '产品状态名称': '正常在用', '客户经理名称': '甲', '客户经理工号': 'A1', '开始时间': `${year}-02-01`, '活动套餐资费': '100', ...values
  });
  function importRows(rows) {
    const book = XLSX.utils.book_new();
    const headers = excelHeaders;
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows.map((row) => Object.fromEntries(headers.map((header) => [header, row[header] ?? '']))), { header: headers }), 'Sheet1');
    XLSX.writeFile(book, path);
    return importer.importExcel(path, 'changes.xlsx');
  }
  const byType = (batchId) => {
    const counts = {};
    for (const row of db.prepare('SELECT change_type, COUNT(*) c FROM ledger_change WHERE batch_id = ? GROUP BY change_type').all(batchId)) counts[row.change_type] = row.c;
    return counts;
  };

  const first = importRows([line('C1'), line('C2'), line('C3'), line('C4')]);
  // Lines from earlier tests are reported as gone once; these four are new.
  assert.equal(first.changes.counts.added, 4);
  const netAfterFirst = first.changes.netAfter;
  assert.equal(netAfterFirst - first.changes.netBefore, 4);

  const second = importRows([
    line('C1', { '产品状态名称': '正式销户', '状态时间': `${year}-03-01` }),
    line('C2', { '客户经理名称': '乙', '客户经理工号': 'B2', '活动套餐资费': '200' }),
    line('C3', { '活动套餐资费': '' }),
    line('C5')
  ]);
  assert.deepEqual(byType(second.batchId), { cancelled: 1, manager: 2, fee: 1, added: 1, missing: 1 });
  assert.equal(second.changes.counts.manager, 1, 'one line, even when name and job number both change');
  assert.equal(second.changes.netBefore, netAfterFirst);
  // C1 cancelled, C5 added: 新增 keeps C1 too, since it started this year, so the net moves by one each way.
  assert.equal(second.changes.netAfter, netAfterFirst + 1 - 1);

  const stored = (code, type) => db.prepare('SELECT * FROM ledger_change WHERE batch_id = ? AND group_product_code = ? AND change_type = ?').get(second.batchId, code, type);
  assert.deepEqual([stored('C1', 'cancelled').old_value, stored('C1', 'cancelled').new_value], ['正常在用', '正式销户']);
  assert.match(stored('C1', 'cancelled').note, /状态时间/);
  assert.deepEqual([stored('C2', 'fee').old_value, stored('C2', 'fee').new_value], ['100', '200']);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM ledger_change WHERE batch_id = ? AND group_product_code = ?').get(second.batchId, 'C3').c, 0, 'a blank fee keeps the stored one, so nothing changed');
  assert.match(stored('C4', 'missing').note, /没有这条/);
  assert.equal(db.prepare('SELECT product_status_name AS s FROM leased_line WHERE group_product_code = ?').get('C4').s, '正常在用', 'a vanished line keeps its data');

  const third = importRows([line('C1', { '产品状态名称': '正式销户', '状态时间': `${year}-03-01` }), line('C2', { '客户经理名称': '乙', '客户经理工号': 'B2', '活动套餐资费': '200' }), line('C3'), line('C4'), line('C5')]);
  assert.deepEqual(byType(third.batchId), { restored: 1 }, 'an unchanged report records nothing but the line that came back');
  assert.equal(importRows([line('C1', { '产品状态名称': '正式销户', '状态时间': `${year}-03-01` }), line('C2', { '客户经理名称': '乙', '客户经理工号': 'B2', '活动套餐资费': '200' }), line('C3'), line('C4'), line('C5')]).changes.netBefore, third.changes.netAfter);

  const page = await (await request(`/api/imports/${second.batchId}/changes?limit=2`)).json();
  assert.equal(page.rows.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.summary.netBefore, netAfterFirst);
  const rest = await (await request(`/api/imports/${second.batchId}/changes?limit=100&before=${page.rows[1].id}`)).json();
  assert.equal(page.rows.length + rest.rows.length, 6);
  const onlyCancelled = await (await request(`/api/imports/${second.batchId}/changes?type=cancelled`)).json();
  assert.deepEqual(onlyCancelled.rows.map((row) => row.group_product_code), ['C1']);
  assert.equal((await request(`/api/imports/${second.batchId}/changes`, {}, false)).status, 401);

  const lineId = db.prepare('SELECT id FROM leased_line WHERE group_product_code = ?').get('C2').id;
  const history = await (await request(`/api/ledger/${lineId}/changes`)).json();
  assert.ok(history.some((row) => row.change_type === 'fee' && row.new_value === '200'));
  assert.ok(history.some((row) => row.change_type === 'added'));

  const stats = await (await request(`/api/stats?month=${year}-01`)).json();
  assert.ok(stats.lastImportAt, 'pages can say how current the data is');
});

test('year and quarter export lists the added and cancelled lines behind the period totals', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const insert = db.prepare(`INSERT INTO leased_line
    (group_code, group_name, group_product_code, product_name, product_status_name, ledger_status,
     manager_name, start_time, status_time, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('00123', 'Period New', 'PGP001', '互联网专线', '正常在用', '正常在用', 'Dan', `${today} 09:00:00`, `${today} 09:00:00`, nowIso());
  insert.run('00456', 'Period Closed', 'PGP002', '互联网专线', '正式销户', '正式销户', 'Dan', '2020-01-05', `${today} 10:00:00`, nowIso());
  insert.run('00789', 'Period Non KPI', 'PGP003', '其他产品', '正常在用', '正常在用', 'Dan', `${today} 11:00:00`, null, nowIso());

  async function exportedSheets(query) {
    const response = await request(`/api/ledger/export-period?${query}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /spreadsheetml/);
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
    const workbook = XLSX.read(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual(workbook.SheetNames, ['新增', '销户']);
    return {
      added: XLSX.utils.sheet_to_json(workbook.Sheets['新增'], { raw: false }),
      cancelled: XLSX.utils.sheet_to_json(workbook.Sheets['销户'], { raw: false })
    };
  }

  const stats = await (await request(`/api/stats?month=${today.slice(0, 7)}&kpiMode=1`)).json();
  const year = await exportedSheets('period=year&kpiMode=1');
  const quarter = await exportedSheets('period=quarter&kpiMode=1');
  assert.equal(year.added.length, stats.addedInCurrentYear);
  assert.equal(year.cancelled.length, stats.cancelledInCurrentYear);
  assert.equal(quarter.added.length, stats.addedInCurrentQuarter);
  assert.equal(quarter.cancelled.length, stats.cancelledInCurrentQuarter);

  assert.ok(year.added.some((row) => row['集团编码'] === '00123'));
  assert.ok(!year.added.some((row) => row['集团名称'] === 'Period Closed'));
  assert.ok(year.cancelled.some((row) => row['集团编码'] === '00456'));
  assert.ok(!year.added.some((row) => row['集团名称'] === 'Period Non KPI'));

  const allProducts = await exportedSheets('period=year&kpiMode=0');
  assert.ok(allProducts.added.some((row) => row['集团名称'] === 'Period Non KPI'));
});

test('KPI achievement counts this year net, matches groups and keeps forecasts', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const insert = db.prepare(`INSERT INTO leased_line
    (group_code, group_name, group_product_code, product_name, product_status_name, ledger_status,
     manager_name, start_time, status_time, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('KPI001', 'Kpi Group', 'KGP001', '互联网专线', '正常在用', '正常在用', '张凯', `${today} 09:00:00`, null, nowIso());
  insert.run('KPI001', 'Kpi Group', 'KGP002', '传输专线', '正常在用', '正常在用', '张凯', `${today} 09:00:00`, null, nowIso());
  insert.run('KPI001', 'Kpi Group Old', 'KGP003', '传输专线', '正式销户', '正式销户', '冯琼', '2020-01-01', `${today} 09:00:00`, nowIso());

  const stats = await (await request(`/api/stats?month=${today.slice(0, 7)}&kpiMode=1`)).json();
  const overview = await (await request('/api/kpi?kpiMode=1')).json();
  assert.equal(overview.target, 230);
  // Forecasts can be set from this month to the end of next year.
  const thisYear = Number(today.slice(0, 4));
  const monthNow = Number(today.slice(5, 7));
  assert.equal(overview.currentMonth, monthNow);
  assert.deepEqual(overview.months[0], { year: thisYear, month: monthNow });
  assert.equal(overview.months.length, 12 - monthNow + 1 + 12);
  assert.deepEqual(overview.months.at(-1), { year: thisYear + 1, month: 12 });
  assert.equal(overview.actual.added, stats.addedInCurrentYear);
  assert.equal(overview.actual.cancelled, stats.cancelledInCurrentYear);
  assert.equal(overview.actual.net, stats.addedInCurrentYear - stats.cancelledInCurrentYear);
  // The month-by-month series adds up to the year's totals, this month included.
  assert.deepEqual(overview.monthly.map((row) => row.month), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(overview.monthly.reduce((sum, row) => sum + row.added, 0), overview.actual.added);
  assert.equal(overview.monthly.reduce((sum, row) => sum + row.cancelled, 0), overview.actual.cancelled);
  const thisMonth = overview.monthly[Number(today.slice(5, 7)) - 1];
  assert.ok(thisMonth.added >= 2 && thisMonth.cancelled >= 1);
  const zhang = overview.managers.find((row) => row.manager_name === '张凯');
  assert.ok(zhang.added >= 2);
  assert.equal(zhang.net, zhang.added - zhang.cancelled);
  assert.equal(overview.forecast.added, 0);

  const groups = await (await request('/api/kpi/groups?q=KPI00')).json();
  assert.deepEqual(groups.find((row) => row.group_code === 'KPI001'), { group_code: 'KPI001', group_name: 'Kpi Group', manager_name: '张凯', source: 'ledger' });
  assert.deepEqual(await (await request('/api/kpi/groups?q=')).json(), []);

  const invalid = [
    { group_code: '', product_type: '互联网专线', line_count: 1, month: 11 },
    { group_code: 'KPI001', product_type: '不存在', line_count: 1, month: 11 },
    { group_code: 'KPI001', product_type: '互联网专线', line_count: 1, year: thisYear - 1, month: 12 },
    { group_code: 'KPI001', product_type: '互联网专线', line_count: 1, month: 13 },
    { group_code: 'KPI001', product_type: '互联网专线', line_count: 1, month: 12, confidence: 'sure' },
    { group_code: 'KPI001', product_type: '互联网专线', line_count: 0, month: 12 },
    { group_code: 'NEW999', product_type: '互联网专线', line_count: 1, month: 12, group_name: '' }
  ];
  for (const body of invalid) {
    assert.equal((await request('/api/kpi/forecasts', { method: 'POST', body })).status, 400);
  }

  // A known group takes the ledger's name and manager, whatever the form sent.
  const known = await request('/api/kpi/forecasts', {
    method: 'POST', body: { group_code: 'KPI001', group_name: 'typed', manager_name: '王倩', product_type: '互联网专线', line_count: 3, month: 12 }
  });
  assert.equal(known.status, 201);
  const knownRow = await known.json();
  assert.equal(knownRow.group_name, 'Kpi Group');
  assert.equal(knownRow.manager_name, '张凯');
  const fresh = await request('/api/kpi/forecasts', {
    method: 'POST', body: { group_code: 'NEW999', group_name: '新集团', manager_name: '王倩', product_type: 'SPN专线', line_count: 2, month: 12 }
  });
  assert.equal(fresh.status, 201);
  const freshRow = await fresh.json();

  const cancel = await request('/api/kpi/forecasts', {
    method: 'POST', body: { kind: 'cancelled', group_code: 'KPI001', product_type: '传输专线', line_count: 1, month: 12 }
  });
  assert.equal(cancel.status, 201);
  assert.equal((await cancel.json()).kind, 'cancelled');
  assert.equal((await request('/api/kpi/forecasts', {
    method: 'POST', body: { kind: 'moved', group_code: 'KPI001', product_type: '传输专线', line_count: 1, month: 12 }
  })).status, 400);

  let next = await (await request('/api/kpi?kpiMode=1')).json();
  assert.equal(next.forecast.added, 5);
  assert.equal(next.forecast.cancelled, 1);
  assert.equal(next.forecast.net, 4);
  assert.deepEqual(next.forecast.byMonth, { 12: { added: 5, cancelled: 1 } });
  assert.deepEqual(next.forecast.byConfidence.unrated, { added: 5, cancelled: 1 }, 'a forecast sent without a confidence level waits to be rated');
  assert.equal(next.forecast.expectedNet, next.actual.net + 5 - 1);

  // The year's target is editable and replaces the default.
  assert.equal((await request('/api/kpi/target', { method: 'PUT', body: { target: 0 } })).status, 400);
  assert.equal((await request('/api/kpi/target', { method: 'PUT', body: { target: 2.5 } })).status, 400);
  assert.equal((await request('/api/kpi/target', { method: 'PUT', body: { target: 260 } })).status, 200);
  next = await (await request('/api/kpi?kpiMode=1')).json();
  assert.equal(next.target, 260);
  assert.equal(next.defaultTarget, 230);

  assert.equal((await request(`/api/kpi/forecasts/${knownRow.id}`, { method: 'PATCH', body: { landed: true } })).status, 200);
  assert.equal((await request(`/api/kpi/forecasts/${freshRow.id}`, { method: 'PATCH', body: { line_count: 4 } })).status, 200);
  assert.equal((await request(`/api/kpi/forecasts/${freshRow.id}`, { method: 'PATCH', body: { line_count: -1 } })).status, 400);
  next = await (await request('/api/kpi?kpiMode=1')).json();
  assert.equal(next.forecast.added, 4);
  assert.equal(next.forecasts.find((row) => row.id === knownRow.id).landed, true);

  // Progress: partial landing lowers what still counts, and each update keeps its server time.
  const progressUrl = `/api/kpi/forecasts/${freshRow.id}/progress`;
  const update = (body) => request(progressUrl, { method: 'POST', body });
  assert.equal((await update({ note: '   ' })).status, 400);
  assert.equal((await update({ note: 'x'.repeat(501) })).status, 400);
  assert.equal((await update({ note: '超出', landed_count: 5 })).status, 400);
  assert.equal((await update({ note: '负数', landed_count: -1 })).status, 400);
  assert.equal((await update({ note: '小数', landed_count: 1.5 })).status, 400);
  assert.equal((await request('/api/kpi/forecasts/999999/progress', { method: 'POST', body: { note: 'x' } })).status, 404);
  assert.equal((await request('/api/kpi/forecasts/999999/progress')).status, 404);

  const beforeUpdate = Date.now();
  const noted = await update({ note: '已签合同，等施工', created_at: '2000-01-01T00:00:00Z' });
  assert.equal(noted.status, 201);
  const notedRow = await noted.json();
  assert.equal(notedRow.landed_count, 0, 'leaving the count out keeps it as it was');
  assert.equal(notedRow.latest_note, '已签合同，等施工');
  const stamped = new Date(notedRow.latest_at).getTime();
  assert.ok(stamped >= beforeUpdate - 1000 && stamped <= Date.now() + 1000, 'the time is the server clock, not the request');

  assert.equal((await update({ note: '开通 3 条', landed_count: 3 })).status, 201);
  next = await (await request('/api/kpi?kpiMode=1')).json();
  const partial = next.forecasts.find((row) => row.id === freshRow.id);
  assert.deepEqual([partial.line_count, partial.landed_count, partial.remaining, partial.landed], [4, 3, 1, false]);
  assert.equal(partial.latest_note, '开通 3 条');
  assert.equal(next.forecast.added, 1, 'only the part not yet landed still counts');
  assert.deepEqual(next.forecast.byMonth[12], { added: 1, cancelled: 1 });
  assert.equal(next.forecast.expectedNet, next.actual.net + 1 - 1);

  const history = await (await request(progressUrl)).json();
  assert.deepEqual(history.entries.map((entry) => entry.note), ['开通 3 条', '已签合同，等施工']);
  assert.deepEqual(history.entries.map((entry) => entry.landed_count), [3, 0]);
  assert.equal(history.entries[0].created_by, 'admin');

  assert.equal((await request(`/api/kpi/forecasts/${freshRow.id}`, { method: 'PATCH', body: { line_count: 2 } })).status, 400, 'fewer lines than have landed');

  // The one-click buttons act on the whole forecast and leave a trace.
  assert.equal((await (await request(`/api/kpi/forecasts/${freshRow.id}`, { method: 'PATCH', body: { landed: true } })).json()).remaining, 0);
  assert.equal((await (await request(progressUrl)).json()).entries[0].note, '标记为全部落地');
  const restored = await (await request(`/api/kpi/forecasts/${freshRow.id}`, { method: 'PATCH', body: { landed: false } })).json();
  assert.deepEqual([restored.landed_count, restored.remaining], [0, 4]);
  assert.equal(restored.latest_note, '恢复为预计');

  assert.equal((await request(`/api/kpi/forecasts/${freshRow.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM kpi_forecast_progress WHERE forecast_id = ?').get(freshRow.id).count, 0, 'its history goes with it');
  assert.equal((await request(`/api/kpi/forecasts/${freshRow.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await request(`/api/kpi/forecasts/${freshRow.id}`, { method: 'DELETE' })).status, 404);
  next = await (await request('/api/kpi?kpiMode=1')).json();
  assert.equal(next.forecast.added, 0);
  assert.equal(next.forecast.cancelled, 1);
  assert.equal(next.forecasts.length, 2);
});

test('new lines are offered to the forecast they may answer, and nothing counts until confirmed', async () => {
  const path = join(tempDir, 'suggest.xlsx');
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date());
  const line = (code, values = {}) => ({
    '集团编码': 'SUG1', '集团名称': '建议集团', '集团产品编码': code, '产品名称': '互联网专线',
    '产品状态名称': '正常在用', '客户经理名称': '甲', '开始时间': `${year}-02-01`, ...values
  });
  const importRows = (rows) => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows.map((row) => Object.fromEntries(excelHeaders.map((header) => [header, row[header] ?? '']))), { header: excelHeaders }), 'Sheet1');
    XLSX.writeFile(book, path);
    return importer.importExcel(path, 'suggest.xlsx');
  };
  const overview = async () => (await request('/api/kpi?kpiMode=1')).json();
  const forecastIn = (data, id) => data.forecasts.find((row) => row.id === id);
  const create = async (body) => (await (await request('/api/kpi/forecasts', { method: 'POST', body: { group_code: 'SUG1', group_name: '建议集团', manager_name: '甲', month: 12, ...body } })).json()).id;
  const decide = (id, lineId, action) => request(`/api/kpi/forecasts/${id}/matches`, { method: 'POST', body: { line_id: lineId, action } });
  const lineIdOf = (code) => db.prepare('SELECT id FROM leased_line WHERE group_product_code = ?').get(code).id;

  importRows([line('OLD1'), line('OLD2')]);
  const first = await create({ product_type: '互联网专线', line_count: 2 });
  const second = await create({ product_type: '互联网专线', line_count: 1 });
  const cancelling = await create({ kind: 'cancelled', product_type: '互联网专线', line_count: 1 });
  const before = (await overview()).forecast;
  assert.equal(forecastIn(await overview(), first).suggestions, 0, 'lines already there are not news');

  // The next report: another KPI product is offered with a flag; a non-KPI line and another group's are not.
  importRows([
    line('OLD1'),
    line('OLD2', { '产品状态名称': '正式销户', '状态时间': `${year}-10-01` }),
    line('NEW1'),
    line('NEW2', { '产品名称': '传输专线' }),
    line('NEW3', { '产品名称': '其他产品' }),
    line('NEW4', { '集团编码': 'SUG2', '集团名称': '别的集团' })
  ]);
  let data = await overview();
  assert.equal(forecastIn(data, first).suggestions, 2);
  assert.equal(forecastIn(data, second).suggestions, 2);
  assert.equal(forecastIn(data, cancelling).suggestions, 1);
  assert.equal(forecastIn(data, first).landed_count, 0, 'nothing lands on its own');
  assert.deepEqual([data.forecast.added, data.forecast.cancelled], [before.added, before.cancelled], 'suggestions alone change no number');

  const detail = await (await request(`/api/kpi/forecasts/${first}/progress`)).json();
  assert.deepEqual(Object.fromEntries(detail.suggestions.map((item) => [item.group_product_code, item.sameProduct])), { NEW1: true, NEW2: false });

  assert.equal((await decide(first, lineIdOf('NEW3'), 'confirm')).status, 409, 'only what is on offer can be answered');
  assert.equal((await decide(first, lineIdOf('NEW1'), 'other')).status, 400);
  assert.equal((await decide(999999, lineIdOf('NEW1'), 'confirm')).status, 404);

  // Confirming counts one line, leaves a trace, and takes the line off every other forecast.
  const confirmed = await decide(first, lineIdOf('NEW1'), 'confirm');
  assert.equal(confirmed.status, 200);
  const afterConfirm = await confirmed.json();
  assert.deepEqual([afterConfirm.forecast.landed_count, afterConfirm.forecast.remaining], [1, 1]);
  assert.match(afterConfirm.forecast.latest_note, /确认落地 1 条：NEW1/);
  data = await overview();
  assert.equal(data.forecast.added, before.added - 1);
  assert.equal(forecastIn(data, second).suggestions, 1, 'NEW2 is still open; NEW1 is taken');
  assert.equal((await decide(second, lineIdOf('NEW1'), 'confirm')).status, 409, 'a line counts once');

  // Dismissing affects only that forecast.
  assert.equal((await decide(first, lineIdOf('NEW2'), 'dismiss')).status, 200);
  data = await overview();
  assert.equal(forecastIn(data, first).suggestions, 0);
  assert.equal(forecastIn(data, first).landed_count, 1);
  assert.equal(forecastIn(data, second).suggestions, 1);

  // A filled forecast stops asking, and answering it is refused.
  assert.equal((await decide(second, lineIdOf('NEW2'), 'confirm')).status, 200);
  assert.equal(forecastIn(await overview(), second).suggestions, 0);
  assert.equal((await decide(second, lineIdOf('NEW2'), 'confirm')).status, 409);

  // A cancellation forecast is offered the line that was cancelled.
  const cancelDetail = await (await request(`/api/kpi/forecasts/${cancelling}/progress`)).json();
  assert.deepEqual(cancelDetail.suggestions.map((item) => item.group_product_code), ['OLD2']);
  const cancelConfirmed = await (await decide(cancelling, lineIdOf('OLD2'), 'confirm')).json();
  assert.match(cancelConfirmed.forecast.latest_note, /确认销户 1 条：OLD2/);

  // Back to all forecast frees its confirmed lines to be offered again.
  const restored = await (await request(`/api/kpi/forecasts/${second}`, { method: 'PATCH', body: { landed: false } })).json();
  assert.equal(restored.landed_count, 0);
  assert.equal(forecastIn(await overview(), second).suggestions, 1);

  // Through the real upload route the answer says how many are waiting. The route keeps its
  // upload, so this removes only the one file this request added.
  const uploads = join(process.cwd(), 'uploads');
  const existing = new Set(readdirSync(uploads));
  importRows([line('OLD1'), line('OLD2', { '产品状态名称': '正式销户', '状态时间': `${year}-10-01` }), line('NEW1'), line('NEW2', { '产品名称': '传输专线' }), line('NEW3', { '产品名称': '其他产品' }), line('NEW4', { '集团编码': 'SUG2', '集团名称': '别的集团' })]);
  const form = new FormData();
  form.append('file', new Blob([readFileSync(path)]), 'suggest.xlsx');
  const uploaded = await request('/api/import', { method: 'POST', body: form });
  for (const name of readdirSync(uploads)) if (!existing.has(name)) rmSync(join(uploads, name), { force: true });
  assert.equal(uploaded.status, 200);
  assert.equal((await uploaded.json()).forecastSuggestions, 1);

  assert.equal((await request(`/api/kpi/forecasts/${first}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM kpi_forecast_match WHERE forecast_id = ?').get(first).c, 0);
  for (const id of [second, cancelling]) await request(`/api/kpi/forecasts/${id}`, { method: 'DELETE' });
});

test('backups are readable copies, kept by kind, and weekly ones fall due after seven days', async () => {
  const { createBackupService } = await import('../server/lib/backup.js');
  const { dbPath } = await import('../server/lib/db.js');
  const dir = join(tempDir, 'backup-unit');
  let clock = new Date('2026-11-01T00:00:00Z');
  const backups = createBackupService({ db, dbPath, dir, now: () => clock });

  assert.equal(backups.weeklyDue(), true, 'no weekly backup yet');
  const weekly = await backups.create('weekly', { detail: '测试' });
  assert.equal(backups.weeklyDue(), false);
  clock = new Date('2026-11-07T23:59:59Z');
  assert.equal(backups.weeklyDue(), false);
  clock = new Date('2026-11-08T00:00:00Z');
  assert.equal(backups.weeklyDue(), true);

  // The file unpacks into a database with the same data.
  const lines = db.prepare('SELECT COUNT(*) AS c FROM leased_line').get().c;
  const copyPath = join(tempDir, 'backup-copy.db');
  writeFileSync(copyPath, gunzipSync(readFileSync(join(dir, weekly.name))));
  const copy = new DatabaseSync(copyPath, { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS c FROM leased_line').get().c, lines);
  copy.close();
  assert.equal(weekly.counts.leasedLines, lines);
  assert.ok(weekly.size > 0 && weekly.databaseSize > 0);

  // Each kind keeps its own newest few; the oldest manual one goes, the weekly one stays.
  const manual = [];
  for (let index = 0; index < 11; index += 1) {
    clock = new Date(clock.getTime() + 1000);
    manual.push(await backups.create('manual'));
  }
  const kept = backups.list();
  assert.equal(kept.filter((item) => item.reason === 'manual').length, 10);
  assert.ok(!kept.some((item) => item.name === manual[0].name));
  assert.ok(kept.some((item) => item.name === weekly.name));
  assert.equal(readdirSync(dir).filter((name) => name.endsWith('.db.gz')).length, 11);
  assert.equal(readdirSync(dir).filter((name) => name.startsWith('.')).length, 0, 'no temporary files left');
  assert.equal(backups.file('../ledger.db'), null);
  assert.equal(backups.file(manual[0].name), null);
  assert.ok(backups.file(weekly.name));
  await assert.rejects(backups.create('nope'), /未知的备份原因/);
});

test('a rollback puts one kind of data back, backs up first, and can itself be undone', async () => {
  const { createBackupService } = await import('../server/lib/backup.js');
  const { dbPath } = await import('../server/lib/db.js');
  const backups = createBackupService({ db, dbPath, dir: join(tempDir, 'backup-restore') });
  const at = nowIso();
  const lineId = Number(db.prepare("INSERT INTO leased_line (group_code, group_product_code, product_name, product_status_name, updated_at) VALUES ('RSG', 'RS1', '互联网专线', '正常在用', ?)").run(at).lastInsertRowid);
  db.prepare("INSERT INTO line_warning_mark (line_id, mark, updated_at) VALUES (?, 'remind', ?)").run(lineId, at);
  db.prepare("INSERT INTO strategic_customer (group_code, group_name, manager_name) VALUES ('RSG1', '战客一', '冯琼')").run();
  const users = db.prepare('SELECT COUNT(*) AS c FROM auth_user').get().c;
  const backup = await backups.create('manual');

  // After the backup: a wrong import changes a line and adds one, a manual edit, a forecast, a new strategic group.
  db.prepare("UPDATE leased_line SET product_status_name = '正式销户', updated_at = ? WHERE id = ?").run(`${at}x`, lineId);
  db.prepare("INSERT INTO leased_line (group_code, group_product_code, product_name, product_status_name) VALUES ('RSG', 'RS2', '互联网专线', '正常在用')").run();
  db.prepare("INSERT INTO import_batch (id, file_name, status, imported_at) VALUES ('RS-BATCH', '导错的清单.xlsx', 'finished', ?)").run(at);
  db.prepare("INSERT INTO change_log (leased_line_id, field_name, old_value, new_value, changed_by) VALUES (?, 'remark', '', '手工', 'admin')").run(lineId);
  db.prepare("INSERT INTO kpi_forecast (year, month, group_code, group_name, manager_name, product_type, line_count, created_at, updated_at, kind) VALUES (2026, 12, 'RSG', '集团', '冯琼', '互联网专线', 1, ?, ?, 'added')").run(at, at);
  db.prepare("INSERT INTO strategic_customer (group_code, group_name, manager_name) VALUES ('RSG2', '战客二', '冯琼')").run();

  const preview = await backups.preview(backup.name, 'ledger');
  assert.deepEqual(preview.imports.map((item) => item.fileName), ['导错的清单.xlsx']);
  assert.deepEqual([preview.linesAdded, preview.linesChanged, preview.linesRemoved, preview.manualEdits, preview.forecastsChanged], [1, 1, 0, 1, 1]);
  const lineRow = preview.tables.find((row) => row.table === 'leased_line');
  assert.equal(lineRow.current, lineRow.backup + 1);
  await assert.rejects(backups.preview(backup.name, 'everything'), /请选择要回退的数据范围/);
  await assert.rejects(backups.restore('ledger-20260101T000000Z-manual-000000.db.gz', 'ledger'), /找不到/);

  const status = (code) => db.prepare('SELECT product_status_name AS s FROM leased_line WHERE group_product_code = ?').get(code)?.s ?? null;
  const result = await backups.restore(backup.name, 'ledger');
  assert.equal(result.before.reason, 'before-restore');
  assert.deepEqual([status('RS1'), status('RS2')], ['正常在用', null]);
  assert.equal(db.prepare('SELECT mark FROM line_warning_mark WHERE line_id = ?').get(lineId).mark, 'remind', 'marks come back with their line');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM import_batch WHERE id = 'RS-BATCH'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM kpi_forecast WHERE group_code = 'RSG'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM strategic_customer WHERE group_code = 'RSG2'").get().c, 1, 'the strategic list is not part of 台账类数据');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM auth_user').get().c, users);

  // Rolling back to the "before" backup undoes the rollback.
  await backups.restore(result.before.name, 'ledger');
  assert.deepEqual([status('RS1'), status('RS2')], ['正式销户', '正常在用']);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM kpi_forecast WHERE group_code = 'RSG'").get().c, 1);

  await backups.restore(backup.name, 'strategic');
  assert.deepEqual(db.prepare("SELECT group_code FROM strategic_customer WHERE group_code LIKE 'RSG%' ORDER BY 1").all().map((row) => row.group_code), ['RSG1']);
  assert.equal(status('RS2'), '正常在用', 'the ledger is not part of 战客清单');
  assert.equal(backups.list().filter((item) => item.reason === 'before-restore').length, 3);

  await backups.restore(backup.name, 'ledger');
  db.prepare('DELETE FROM leased_line WHERE id = ?').run(lineId);
  db.exec("DELETE FROM strategic_customer WHERE group_code LIKE 'RSG%'");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM leased_line WHERE group_product_code LIKE 'RS%'").get().c, 0);
});

test('imports back up first, and a backup downloads only with the authenticator code', async () => {
  const listed = async () => (await (await request('/api/settings/backups')).json()).backups;
  const before = await listed();

  // A file that fails to import still gets its backup first.
  const uploads = join(process.cwd(), 'uploads');
  const existing = new Set(readdirSync(uploads));
  const form = new FormData();
  form.append('file', new Blob(['not a workbook']), 'broken.xlsx');
  const failed = await request('/api/import', { method: 'POST', body: form });
  for (const name of readdirSync(uploads)) if (!existing.has(name)) rmSync(join(uploads, name), { force: true });
  assert.equal(failed.status, 400);
  let after = await listed();
  assert.equal(after.length, before.length + 1);
  assert.deepEqual([after[0].reason, after[0].detail], ['ledger-import', 'broken.xlsx']);

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['集团编码', '集团名称', '客户经理'], ['BK001', '备份测试', '冯琼']]), 'S');
  const strategicForm = new FormData();
  strategicForm.append('file', new Blob([XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })]), 'zk.xlsx');
  const { token } = await (await request('/api/strategic/preview', { method: 'POST', body: strategicForm })).json();
  const committed = await (await request('/api/strategic/commit', { method: 'POST', body: { token } })).json();
  assert.ok(committed.backup);
  assert.equal(committed.backupError, '');
  after = await listed();
  assert.equal(after[0].reason, 'strategic-import');
  assert.equal(after[0].counts.strategicCustomers, 0, 'taken before the list was replaced');
  db.exec('DELETE FROM strategic_customer; DELETE FROM strategic_import');

  const manual = await request('/api/settings/backups', { method: 'POST' });
  assert.equal(manual.status, 201);
  const { name } = await manual.json();

  const secret = db.prepare('SELECT totp_secret FROM auth_user WHERE username = ?').get('admin').totp_secret;
  assert.equal((await request(`/api/settings/backups/${name}/download`, { method: 'POST', body: { code: '000000' } })).status, 403);
  assert.equal((await request('/api/settings/backups/..%2Fledger.db/download', { method: 'POST', body: { code: totp(secret) } })).status, 404);
  const download = await request(`/api/settings/backups/${name}/download`, { method: 'POST', body: { code: totp(secret) } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), new RegExp(name.replaceAll('.', '\\.')));
  assert.ok(gunzipSync(Buffer.from(await download.arrayBuffer())).subarray(0, 15).toString() === 'SQLite format 3');
  // Rolling back over HTTP needs the code too, and is logged.
  const scopeOnly = await request(`/api/settings/backups/${name}/restore-preview`, { method: 'POST', body: { scope: 'strategic' } });
  assert.equal(scopeOnly.status, 200);
  assert.equal((await scopeOnly.json()).tables.length, 2);
  assert.equal((await request(`/api/settings/backups/${name}/restore`, { method: 'POST', body: { scope: 'strategic', code: '000000' } })).status, 403);
  assert.equal((await request(`/api/settings/backups/${name}/restore`, { method: 'POST', body: { scope: 'all', code: totp(secret) } })).status, 400);
  const rolledBack = await request(`/api/settings/backups/${name}/restore`, { method: 'POST', body: { scope: 'strategic', code: totp(secret) } });
  assert.equal(rolledBack.status, 200);
  const restoredResult = await rolledBack.json();
  assert.equal(restoredResult.before.reason, 'before-restore');

  const events = db.prepare("SELECT event, detail FROM security_log WHERE event LIKE 'backup_%' ORDER BY id").all();
  assert.deepEqual(events.map((row) => row.event), ['backup_created', 'backup_downloaded', 'backup_restored']);
  assert.deepEqual(events.slice(0, 2).map((row) => row.detail), [name, name]);
  assert.match(events[2].detail, new RegExp(`战客清单回退到 ${name.replaceAll('.', '\\.')}.*${restoredResult.before.name.replaceAll('.', '\\.')}`));
  assert.equal((await request('/api/settings/backups', {}, false)).status, 401);
  db.exec("DELETE FROM auth_attempt; DELETE FROM security_log WHERE event LIKE 'code_%' OR event LIKE 'backup_%'");
});

test('status changes are sorted into 转正常, 转复机, 转销户, 转停机 and the rest', async () => {
  const { statusChangeType, diffLine } = await import('../server/lib/ledger-changes.js');
  const cases = [
    ['临时生成资料', '正常在用', 'normalized'],
    ['停机', '正常在用', 'resumed'],
    ['停机执行中', '正常在用', 'resumed'],
    ['正常在用', '销户(订单处理中)', 'cancelled'],
    ['停机执行中', '正式销户', 'cancelled'],
    ['停机', '欠费销户', 'cancelled'],
    ['销户(订单处理中)', '正式销户', 'status'],
    ['临时生成资料', '正式销户', 'status'],
    ['正常在用', '停机执行中', 'stopped'],
    ['停机执行中', '停机', 'stopped'],
    ['正常在用', '回退（注销）', 'status'],
    ['', '正常在用', 'status']
  ];
  for (const [from, to, expected] of cases) assert.equal(statusChangeType(from, to), expected, `${from || '空'} → ${to}`);
  const [change] = diffLine({ product_status_name: '停机' }, { product_status_name: '正常在用', status_time: '2026-11-01' });
  assert.deepEqual([change.type, change.oldValue, change.newValue], ['resumed', '停机', '正常在用']);
});

test('a database that ran the v2.1.4beta branch keeps its old tables aside and imports work', async () => {
  const { createStrategicRouter } = await import('../server/lib/strategic.js');
  const { default: express } = await import('express');
  const old = new DatabaseSync(':memory:');
  old.exec('PRAGMA foreign_keys = ON;');
  // The beta's own tables, under the name the release uses too.
  old.exec(`CREATE TABLE strategic_import (
      id TEXT PRIMARY KEY, file_name TEXT NOT NULL, sheet_name TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, committed_at TEXT,
      status TEXT NOT NULL, base_id TEXT, rows_json TEXT NOT NULL,
      source_rows INTEGER NOT NULL, duplicate_rows INTEGER NOT NULL);
    CREATE TABLE strategic_group (
      group_code TEXT PRIMARY KEY, group_name TEXT NOT NULL, manager_name TEXT NOT NULL,
      region_name TEXT NOT NULL, extra_json TEXT NOT NULL, batch_id TEXT NOT NULL REFERENCES strategic_import(id));
    INSERT INTO strategic_import VALUES ('B1', 'beta.xlsx', 'S', 'admin', 'x', 'x', 'committed', NULL, '[]', 1, 0);
    INSERT INTO strategic_group VALUES ('G1', '旧战客', '甲', '', '{}', 'B1');
    CREATE TABLE leased_line (id INTEGER PRIMARY KEY, group_code TEXT, group_name TEXT, group_product_code TEXT, group_user_name TEXT,
      product_name TEXT, product_status_name TEXT, ledger_status TEXT, bandwidth TEXT, manager_name TEXT,
      start_time TEXT, status_time TEXT, actual_monthly_fee REAL, package_fee REAL);
    INSERT INTO leased_line (group_code, product_status_name, product_name) VALUES ('BG1', '正常在用', '互联网专线');`);
  const deps = { db: old, leasedLineSource: () => 'leased_line', currentUser: () => ({ username: 'admin' }) };
  const app = express();
  app.use(express.json());
  app.use('/s', createStrategicRouter(deps));
  createStrategicRouter(deps); // A second start changes nothing.
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/s`;
  try {
    const tables = old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'strategic%' ORDER BY name").all().map((row) => row.name);
    assert.deepEqual(tables, ['strategic_customer', 'strategic_group', 'strategic_import', 'strategic_import_v214beta']);
    assert.equal(old.prepare('SELECT file_name FROM strategic_import_v214beta').get().file_name, 'beta.xlsx', 'the beta rows are kept');
    assert.match(old.prepare("SELECT sql FROM sqlite_master WHERE name = 'strategic_group'").get().sql, /REFERENCES "?strategic_import_v214beta"?/);

    const empty = await fetch(base);
    assert.equal(empty.status, 200, await empty.clone().text());
    assert.equal((await empty.json()).list, null);

    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['集团编码', '集团名称', '客户经理'], ['BG1', '战客', '冯琼']]), 'S');
    const form = new FormData();
    form.append('file', new Blob([XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })]), 'zk.xlsx');
    const { token } = await (await fetch(`${base}/preview`, { method: 'POST', body: form })).json();
    const committed = await fetch(`${base}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(committed.status, 200);
    const listed = await (await fetch(base)).json();
    assert.equal(listed.list.row_count, 1);
    assert.equal(listed.groups[0].status, 'penetrated');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    old.close();
  }
});

test('strategic customer list sorts groups into penetrated, lost and untouched', async () => {
  const insert = db.prepare(`INSERT INTO leased_line
    (group_code, group_name, group_product_code, product_name, product_status_name, ledger_status, manager_name, start_time, status_time, package_fee, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const line = (group, code, product, status, start = '2025-03-01', statusTime = null, fee = 100) =>
    insert.run(group, `台账${group}`, code, product, status, status, '张凯', start, statusTime, fee, nowIso());
  line('ZK001', 'ZKL1', '互联网专线', '正常在用');
  line('ZK001', 'ZKL2', '传输专线', '正式销户', '2024-01-01', '2026-02-01');
  line('ZK002', 'ZKL3', '互联网专线', '欠费销户', '2024-01-01', '2026-05-06');
  line('ZK003', 'ZKL4', '互联网专线', '回退（注销）');
  line('00ZK5', 'ZKL5', '其他产品', '停机');

  // A title row above the header, rows with missing fields, a duplicate, and a code with leading zeros.
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['2026年战客名单'],
    ['序号', '集团编码', '集团名称', '客户经理'],
    [1, 'ZK001', '战客一', '冯琼'],
    [2, 'ZK002', '战客二', '王倩'],
    [3, 'ZK003', '战客三', '冯琼'],
    [4, 'ZK004', '战客四', '王倩'],
    [5, '00ZK5', '战客五', '冯琼'],
    [6, '', '没有编码', '冯琼'],
    [7, 'ZK006', '', ''],
    [8, 'ZK001', '重复', '王倩']
  ]), '名单');
  const preview = async (bytes, name = 'zk.xlsx') => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), name);
    return request('/api/strategic/preview', { method: 'POST', body: form });
  };
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });

  assert.equal((await request('/api/strategic?kpiMode=1')).status, 200);
  assert.equal((await request('/api/strategic?kpiMode=1', {}, false)).status, 401);

  const noCodeBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(noCodeBook, XLSX.utils.aoa_to_sheet([['名称'], ['某集团']]), 'S');
  const refused = await preview(XLSX.write(noCodeBook, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /集团编码/);
  const twoColumnBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(twoColumnBook, XLSX.utils.aoa_to_sheet([['集团编码', '集团名称'], ['ZK001', '战客一']]), 'S');
  const twoColumns = await preview(XLSX.write(twoColumnBook, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(twoColumns.status, 400);
  assert.match((await twoColumns.json()).error, /缺少“客户经理”列/);

  // The template has the three required columns, 集团编码 formatted as text, and no sample groups.
  const template = await request('/api/strategic/template');
  assert.equal(template.status, 200);
  assert.match(template.headers.get('content-disposition'), /strategic-customer-template\.xlsx/);
  const templateBook = XLSX.read(Buffer.from(await template.arrayBuffer()), { type: 'buffer', cellNF: true, sheetStubs: true });
  assert.deepEqual(templateBook.SheetNames, ['战客清单', '填写说明']);
  assert.deepEqual(XLSX.utils.sheet_to_json(templateBook.Sheets['战客清单'], { header: 1 })[0], ['集团编码', '集团名称', '客户经理']);
  assert.equal(templateBook.Sheets['战客清单'].A2.z, '@');
  assert.equal((await (await preview(Buffer.from(await (await request('/api/strategic/template')).arrayBuffer()))).json()).error, '清单里没有战客集团');

  const previewResponse = await preview(bytes);
  assert.equal(previewResponse.status, 200);
  const shown = await previewResponse.json();
  assert.deepEqual([shown.rowCount, shown.incomplete, shown.duplicates, shown.inLedger, shown.replacing], [5, 2, 1, 4, false]);
  assert.deepEqual(shown.incompleteRows, [{ row: 8, missing: ['集团编码'] }, { row: 9, missing: ['集团名称', '客户经理'] }]);
  assert.equal(shown.columns.manager_name, '客户经理');
  assert.equal((await (await request('/api/strategic?kpiMode=1')).json()).groups.length, 0, 'a preview changes nothing');

  assert.equal((await request('/api/strategic/commit', { method: 'POST', body: { token: 'nope' } })).status, 409);
  const committed = await request('/api/strategic/commit', { method: 'POST', body: { token: shown.token } });
  assert.equal(committed.status, 200);
  assert.equal((await request('/api/strategic/commit', { method: 'POST', body: { token: shown.token } })).status, 409, 'a preview is used once');

  const byCode = (data) => Object.fromEntries(data.groups.map((row) => [row.groupCode, row]));
  let data = await (await request('/api/strategic?kpiMode=1')).json();
  let groups = byCode(data);
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([code, row]) => [code, row.status])), {
    ZK001: 'penetrated', ZK002: 'lost', ZK003: 'untouched', ZK004: 'untouched', '00ZK5': 'untouched'
  });
  assert.deepEqual([groups.ZK001.activeLines, groups.ZK001.cancelledLines, groups.ZK001.activeMonthlyFee], [1, 1, 100]);
  assert.equal(groups.ZK001.managerName, '冯琼', 'the manager comes from the list, not the ledger');
  assert.equal(groups.ZK002.managerName, '王倩');
  assert.equal(groups.ZK002.lastCancelledAt, '2026-05-06');
  assert.deepEqual([data.summary.total, data.summary.penetrated, data.summary.lost, data.summary.untouched], [5, 1, 1, 3]);
  assert.equal(data.summary.penetrationRate, 0.2);
  assert.equal(data.list.row_count, 5);

  // Outside the KPI products the stopped line counts, and leading zeros still match.
  data = await (await request('/api/strategic?kpiMode=0')).json();
  assert.equal(byCode(data)['00ZK5'].status, 'penetrated');

  const detail = await (await request('/api/strategic/groups/ZK001?kpiMode=1')).json();
  assert.equal(detail.group.status, 'penetrated');
  assert.deepEqual(detail.lines.map((row) => [row.group_product_code, row.kind]), [['ZKL1', 'active'], ['ZKL2', 'cancelled']]);
  assert.equal((await request('/api/strategic/groups/NOTLISTED')).status, 404);

  // A new list replaces the old one as a whole.
  const smaller = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(smaller, XLSX.utils.aoa_to_sheet([['集团编码', '集团名称', '客户经理'], ['ZK002', '战客二', '王倩'], ['ZK009', '新战客', '冯琼']]), 'S');
  const second = await (await preview(XLSX.write(smaller, { type: 'buffer', bookType: 'xlsx' }))).json();
  assert.deepEqual([second.replacing, second.added, second.removed], [true, 1, 4]);
  await request('/api/strategic/commit', { method: 'POST', body: { token: second.token } });
  data = await (await request('/api/strategic?kpiMode=1')).json();
  assert.deepEqual(data.groups.map((row) => row.groupCode).sort(), ['ZK002', 'ZK009']);
  db.exec("DELETE FROM strategic_customer; DELETE FROM leased_line WHERE group_product_code LIKE 'ZKL%'");
});

test('the workbench sums up the latest import, KPI progress, open warnings and strategic changes', async () => {
  const path = join(tempDir, 'workbench.xlsx');
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date());
  const line = (code, values = {}) => ({
    '集团编码': 'WB1', '集团名称': '工作台集团', '集团产品编码': code, '产品名称': '互联网专线',
    '产品状态名称': '正常在用', '客户经理名称': '甲', '客户经理工号': 'A1', '开始时间': `${year}-02-01`, '活动套餐资费': '100', ...values
  });
  function importRows(rows) {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows.map((row) => Object.fromEntries(excelHeaders.map((header) => [header, row[header] ?? '']))), { header: excelHeaders }), 'Sheet1');
    XLSX.writeFile(book, path);
    return importer.importExcel(path, 'workbench.xlsx');
  }
  db.exec("INSERT INTO strategic_customer (group_code, group_name, manager_name) VALUES ('WB1', '战客甲', '冯琼'), ('WB2', '战客乙', '王倩'), ('WB3', '战客丙', '王倩')");
  importRows([line('WBL1'), line('WBL3', { '集团编码': 'WB3' })]);
  const latest = importRows([
    line('WBL1', { '产品状态名称': '正式销户', '状态时间': `${year}-03-01` }),
    line('WBL2', { '集团编码': 'WB2' }),
    line('WBL3', { '集团编码': 'WB3', '产品状态名称': '停机', '状态时间': `${year}-03-01`, '总欠费': '50' })
  ]);

  const read = async () => (await request('/api/workbench?kpiMode=1')).json();
  const data = await read();
  assert.equal(data.latestImport.id, latest.batchId);
  assert.equal(data.latestImport.fileName, 'workbench.xlsx');
  assert.deepEqual([data.latestImport.changes.counts.added, data.latestImport.changes.counts.cancelled, data.latestImport.changes.counts.stopped], [1, 1, 1]);

  // WB1 lost its only line, WB2 got its first, WB3 still has a line in service (停机 counts).
  assert.equal(data.strategic.listed, true);
  const moves = Object.fromEntries(data.strategic.changes.map((row) => [row.groupCode, `${row.from}→${row.to}`]));
  assert.deepEqual(moves, { WB1: 'penetrated→lost', WB2: 'untouched→penetrated' });
  const wb1 = data.strategic.changes.find((row) => row.groupCode === 'WB1');
  assert.deepEqual(wb1.lines.map((item) => [item.groupProductCode, item.before, item.after]), [['WBL1', '正常在用', '正式销户']]);
  assert.equal(data.strategic.changes.find((row) => row.groupCode === 'WB2').lines[0].before, null, 'a new line has no state before');

  // The KPI figures are the KPI page's own.
  const kpi = await (await request('/api/kpi?kpiMode=1')).json();
  assert.deepEqual(data.kpi.actual, kpi.actual);
  assert.equal(data.kpi.target, kpi.target);
  assert.equal(data.kpi.gap, kpi.target - kpi.actual.net);
  assert.equal(data.kpi.gapAfterForecast, kpi.target - kpi.forecast.expectedNet);
  assert.equal(data.kpi.perMonth, data.kpi.gap > 0 ? Math.ceil(data.kpi.gap / data.kpi.monthsLeft) : 0);
  assert.ok(data.kpi.monthsLeft >= 1 && data.kpi.monthsLeft <= 12);

  // An unmarked warning line counts until someone marks it.
  const stopped = db.prepare("SELECT id FROM leased_line WHERE group_product_code = 'WBL3'").get().id;
  assert.ok(data.warnings.unmarked >= 1);
  assert.equal(data.warnings.unmarked, Object.values(data.warnings.byLevel).reduce((sum, value) => sum + value, 0));
  await request(`/api/warnings/${stopped}`, { method: 'PATCH', body: { mark: 'remind' } });
  assert.equal((await read()).warnings.unmarked, data.warnings.unmarked - 1);

  // Without a strategic list there is nothing to compare.
  db.exec("DELETE FROM strategic_customer WHERE group_code LIKE 'WB%'");
  const withoutList = await read();
  assert.deepEqual([withoutList.strategic.listed, withoutList.strategic.changes.length], [false, 0]);
  assert.equal((await request('/api/workbench', {}, false)).status, 401);
  db.exec("DELETE FROM line_warning_mark WHERE line_id IN (SELECT id FROM leased_line WHERE group_product_code LIKE 'WBL%'); DELETE FROM leased_line WHERE group_product_code LIKE 'WBL%'");
});

test('KPI forecasts carry a confidence level, open months, overdue marks, next year reserve and time pace', async () => {
  const { createKpiRouter: kpiRouterFor } = await import('../server/lib/kpi.js');
  const rules = await import('../server/lib/ledger-rules.js');
  // A fixed day, so the calendar rules do not depend on when the tests run.
  const today = () => ({ year: 2026, month: 11, day: 10, dayOfYear: 314, daysInYear: 365 });
  const router = kpiRouterFor({
    db,
    leasedLineSource: serverModule.leasedLineSource,
    currentUser: () => null,
    currentPeriod: () => ({ year: 2026, yearStart: '2026-01-01', nextYearStart: '2027-01-01' }),
    addedStatuses: rules.addedStatuses,
    cancelledStatuses: rules.cancelledStatuses,
    productTypes: rules.kpiProductNames,
    today
  });
  const insert = db.prepare(`INSERT INTO kpi_forecast (year, month, kind, group_code, group_name, manager_name, product_type, line_count, landed_count, confidence, created_at, updated_at)
    VALUES (?, ?, ?, 'CONF', '把握集团', '甲', '互联网专线', ?, ?, ?, ?, ?)`);
  const at = nowIso();
  insert.run(2026, 9, 'added', 3, 1, 'possible', at, at); // two of three still to land, and September has passed
  insert.run(2026, 12, 'added', 4, 0, 'certain', at, at);
  insert.run(2026, 12, 'cancelled', 1, 0, 'likely', at, at);
  insert.run(2026, 10, 'added', 2, 2, 'watch', at, at); // landed in full: not overdue
  insert.run(2027, 3, 'added', 5, 0, 'watch', at, at); // next year's reserve
  const base = router.overview({ kpiMode: '1' });
  const mine = (rows) => rows.filter((row) => row.group_code === 'CONF');

  assert.deepEqual(base.months.slice(0, 3), [{ year: 2026, month: 11 }, { year: 2026, month: 12 }, { year: 2027, month: 1 }]);
  assert.equal(base.currentMonth, 11);
  assert.deepEqual(mine(base.forecasts).map((row) => [row.month, row.overdue]), [[9, true], [10, false], [12, false], [12, false]]);
  assert.ok(base.forecast.overdue.forecasts >= 1 && base.forecast.overdue.added >= 2);
  assert.deepEqual(mine(base.reserve).map((row) => [row.year, row.month, row.confidence]), [[2027, 3, 'watch']]);
  assert.ok(!base.forecasts.some((row) => row.year === 2027), 'the reserve never counts toward this year');
  assert.ok(base.forecast.byConfidence.certain.added >= 4);
  assert.ok(base.forecast.byConfidence.likely.cancelled >= 1);
  assert.ok(base.forecast.byConfidence.possible.added >= 2);
  assert.equal(Object.values(base.forecast.byConfidence).reduce((sum, level) => sum + level.added, 0), base.forecast.added);
  assert.deepEqual(base.pace, { elapsed: 314 / 365, dayOfYear: 314, daysInYear: 365, expected: Math.round(base.target * 314 / 365) });

  // Over HTTP: rating and moving a forecast are checked and leave a line in its progress.
  const created = await request('/api/kpi/forecasts', {
    method: 'POST', body: { group_code: 'CONF2', group_name: '把握集团二', manager_name: '甲', product_type: '互联网专线', line_count: 1, month: 12, confidence: 'possible' }
  });
  assert.equal(created.status, 201);
  const id = (await created.json()).id;
  const patch = (body) => request(`/api/kpi/forecasts/${id}`, { method: 'PATCH', body });
  assert.equal((await patch({ confidence: 'sure' })).status, 400);
  assert.equal((await patch({ year: 2000, month: 12 })).status, 400);
  const rated = await patch({ confidence: 'certain' });
  assert.equal(rated.status, 200);
  assert.equal((await rated.json()).confidence, 'certain');
  const thisYear = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()));
  const moved = await patch({ year: thisYear + 1, month: 2 });
  assert.equal(moved.status, 200);
  const movedRow = await moved.json();
  assert.deepEqual([movedRow.year, movedRow.month], [thisYear + 1, 2]);
  const notes = (await (await request(`/api/kpi/forecasts/${id}/progress`)).json()).entries.map((entry) => entry.note);
  assert.deepEqual(notes, [`预计月份：${thisYear}年12月 → ${thisYear + 1}年2月`, '把握度：在谈 → 已签约']);

  db.exec("DELETE FROM kpi_forecast WHERE group_code IN ('CONF', 'CONF2')");
});

test('existing forecasts marked as landed count as fully landed after the upgrade', () => {
  const old = new DatabaseSync(':memory:');
  old.exec(`CREATE TABLE kpi_forecast (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, month INTEGER NOT NULL,
    group_code TEXT NOT NULL, group_name TEXT NOT NULL, manager_name TEXT NOT NULL, product_type TEXT NOT NULL,
    line_count INTEGER NOT NULL CHECK(line_count > 0), landed INTEGER NOT NULL DEFAULT 0, created_by TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'added');
    INSERT INTO kpi_forecast (year, month, group_code, group_name, manager_name, product_type, line_count, landed, created_at, updated_at) VALUES
      (2026, 11, 'A', 'n', 'm', 'SPN专线', 3, 1, 'x', 'x'),
      (2026, 12, 'B', 'n', 'm', 'SPN专线', 2, 0, 'x', 'x');`);
  const deps = { db: old, leasedLineSource: () => 'x', currentUser: () => null, currentPeriod: () => ({}), addedStatuses: [], cancelledStatuses: [], productTypes: [] };
  createKpiRouter(deps);
  createKpiRouter(deps); // A second start changes nothing.
  assert.deepEqual(old.prepare('SELECT group_code, line_count, landed_count FROM kpi_forecast ORDER BY id').all().map((row) => ({ ...row })), [
    { group_code: 'A', line_count: 3, landed_count: 3 },
    { group_code: 'B', line_count: 2, landed_count: 0 }
  ]);
  old.close();
});

test('warning day boundaries, KPI scope, authentication and persistent marks', async () => {
  const { stoppedDays, warningLevel } = await import('../server/lib/warnings.js');
  assert.equal(stoppedDays('2026-10-22 23:59:59', '2026-10-23'), 1);
  assert.equal(stoppedDays('2026-10-23 00:00:00', '2026-10-23'), 0);
  assert.equal(stoppedDays('2025-12-31', '2026-01-01'), 1);
  assert.equal(stoppedDays('2024-02-28', '2024-03-01'), 2);
  assert.equal(stoppedDays('2026-02-29', '2026-10-23'), null);
  assert.equal(stoppedDays('', '2026-10-23'), null);
  assert.equal(stoppedDays('2026-10-24', '2026-10-23'), null);
  assert.equal(stoppedDays('2026-10-22', 'invalid'), null);
  for (const [days, level] of [[0, 'green'], [89, 'green'], [90, 'yellow'], [149, 'yellow'], [150, 'red'], [179, 'red'], [180, 'cancel'], [181, 'cancel']]) {
    assert.equal(warningLevel(days), level);
  }
  const insert = db.prepare(`INSERT INTO leased_line(group_product_code, product_name, product_status_name, status_time, total_arrears)
    VALUES (?, ?, ?, ?, ?)`);
  const line = Number(insert.run('WARN-1', '互联网专线', '停机', '2026-10-22', 100).lastInsertRowid);
  insert.run('WARN-2', 'IMS语音专线', '停机', '2025-12-31', 90);
  insert.run('WARN-3', '互联网专线', '停机', '2026-10-23', 100);
  insert.run('WARN-4', '互联网专线', '停机', '2026-02-01', 0);
  insert.run('WARN-5', '互联网专线', '停机执行中', '2026-02-01', 100);
  insert.run('WARN-6', '互联网专线', '停机', '', 100);
  insert.run('WARN-7', '互联网专线', '停机', '2026-10-24', 100);
  insert.run('WARN-8', '互联网专线', '停机', '2026-10-01', -1);
  const boundaries = [89, 90, 149, 150, 179, 180, 181];
  for (const days of boundaries) {
    const start = new Date(Date.UTC(2026, 9, 23) - days * 86400000).toISOString().slice(0, 10);
    insert.run(`WARN-DAY-${days}`, '互联网专线', '停机', start, 100);
  }
  assert.equal((await request('/api/warnings', {}, false)).status, 401);
  assert.equal((await request(`/api/warnings/${line}`, { method: 'PATCH', body: { mark: 'ignore' } }, false)).status, 401);
  const active = await (await request('/api/warnings?asOf=2026-10-23')).json();
  assert.deepEqual(active.rows.map((row) => row.stopped_days), [181, 180, 179, 150, 149, 90, 89, 1, 0]);
  assert.deepEqual(active.rows.map((row) => row.warning_level), ['cancel', 'cancel', 'red', 'red', 'yellow', 'yellow', 'green', 'green', 'green']);
  assert.equal(active.asOf, '2026-10-23');
  assert.equal(active.invalidDates, 2);
  const all = await (await request('/api/warnings?asOf=2026-10-23&kpiMode=0')).json();
  assert.equal(all.rows.length, active.rows.length + 1);
  assert.equal(all.rows[0].product_name, 'IMS语音专线');
  for (const mark of ['ignore', 'remind', 'unmarked']) {
    assert.equal((await request(`/api/warnings/${line}`, { method: 'PATCH', body: { mark } })).status, 200);
    db.prepare('UPDATE leased_line SET total_arrears = 200 WHERE id = ?').run(line);
    const saved = await (await request('/api/warnings?asOf=2026-10-23')).json();
    assert.equal(saved.rows.find((row) => row.id === line).mark, mark);
  }
  for (const asOf of ['2026-13-01', '2026-02-29', '2026-10', 'invalid', '']) {
    assert.equal((await request(`/api/warnings?asOf=${asOf}`)).status, 400);
  }
  const defaultDate = await (await request('/api/warnings')).json();
  assert.match(defaultDate.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await request(`/api/warnings/${line}`, { method: 'PATCH', body: { mark: 'bad' } })).status, 400);
  assert.equal((await request('/api/warnings/999999', { method: 'PATCH', body: { mark: 'ignore' } })).status, 404);
  db.prepare("DELETE FROM leased_line WHERE group_product_code LIKE 'WARN-%'").run();
});

test('warning mail recipient mapping, preview validation, duplicate control and failed sends', async (t) => {
  const { agentMail } = await import('../server/lib/agent-mail.js');
  let copies = ['audit@example.com'];
  t.mock.method(agentMail, 'defaultCc', () => copies);
  t.mock.method(agentMail, 'status', async () => ({ available: true, loggedIn: true }));
  let calls = 0;
  const sentReports = [];
  t.mock.method(agentMail, 'send', async (report) => { calls++; sentReports.push(report); return { queued: true }; });
  const insert = db.prepare(`INSERT INTO leased_line(group_product_code, group_code, group_name, manager_name, manager_job_no,
    product_name, product_status_name, status_time, total_arrears) VALUES (?, '00012', '测试集团', '同名经理', ?, '互联网专线', '停机', '2026-04-26', 100)`);
  const line = Number(insert.run('MAIL-1', '00123').lastInsertRowid);
  insert.run('MAIL-2', '00456');
  const preview = () => request(`/api/warnings/${line}/reminder/preview`, { method: 'POST', body: { asOf: '2026-10-23', kpiMode: '1' } });
  const send = (previewId) => request(`/api/warnings/${line}/reminder`, { method: 'POST', body: { previewId } });
  const setContact = (email) => request('/api/warnings/mail/contacts', { method: 'PUT', body: { key: 'job:00123', email } });
  assert.equal((await request('/api/warnings/mail/contacts', {}, false)).status, 401);
  assert.equal((await preview()).status, 400);
  assert.equal((await setContact('bad\n@example.com')).status, 400);
  assert.equal((await setContact('a@example.com;b@example.com')).status, 400);
  assert.equal((await request('/api/warnings/mail/contacts', { method: 'PUT', body: { key: 'job:missing', email: 'a@example.com' } })).status, 400);
  assert.equal((await setContact('manager@example.com')).status, 200);
  const contacts = await (await request('/api/warnings/mail/contacts')).json();
  assert.equal(contacts.find((row) => row.key === 'job:00123').email, 'manager@example.com');
  assert.equal(contacts.find((row) => row.key === 'job:00456').email, '');
  assert.equal((await (await request('/api/warnings/mail/status')).json()).loggedIn, true);
  const stale = await (await preview()).json();
  assert.equal(stale.recipient, 'manager@example.com');
  assert.match(stale.body, /停机时长：180 天/);
  assert.match(stale.body, /按业务流程办理销户/);
  await setContact('new@example.com');
  assert.equal((await send(stale.id)).status, 409);
  const expired = await (await preview()).json();
  db.prepare("UPDATE warning_mail_delivery SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(expired.id);
  assert.equal((await send(expired.id)).status, 409);
  const otherActor = await (await preview()).json();
  db.prepare("UPDATE warning_mail_delivery SET actor='another-user' WHERE id=?").run(otherActor.id);
  assert.equal((await send(otherActor.id)).status, 400);
  const changedLine = await (await preview()).json();
  db.prepare('UPDATE leased_line SET total_arrears=101 WHERE id=?').run(line);
  assert.equal((await send(changedLine.id)).status, 409);
  const ready = await (await preview()).json();
  assert.deepEqual(ready.cc, ['audit@example.com']);
  copies = ['updated@example.com'];
  assert.equal((await send(ready.id)).status, 409);
  copies = ['audit@example.com'];
  let completeSend;
  let started;
  const pendingStarted = new Promise((resolve) => { started = resolve; });
  agentMail.send = async (report) => {
    calls++; sentReports.push(report); started();
    await new Promise((resolve) => { completeSend = resolve; });
    return { queued: true };
  };
  const pending = send(ready.id);
  await pendingStarted;
  assert.equal((await send(ready.id)).status, 409);
  completeSend();
  assert.equal((await pending).status, 200);
  assert.equal((await send(ready.id)).status, 200);
  assert.equal(calls, 1);
  assert.equal(sentReports[0].recipient, 'new@example.com');
  assert.deepEqual(sentReports[0].cc, ['audit@example.com']);
  assert.equal(db.prepare('SELECT mark FROM line_warning_mark WHERE line_id=?').get(line).mark, 'remind');
  const duplicate = await (await preview()).json();
  assert.equal((await send(duplicate.id)).status, 409);
  assert.equal(calls, 1);
  assert.equal((await (await request(`/api/warnings/${line}/mail-history`)).json()).some((row) => row.status === 'queued' && row.recipient === 'new@example.com'), true);
  assert.equal(db.prepare('SELECT actor FROM warning_mail_delivery WHERE id=?').get(ready.id).actor, db.prepare('SELECT username FROM auth_user LIMIT 1').get().username);
  db.prepare('DELETE FROM line_warning_mark WHERE line_id=?').run(line);
  db.prepare('UPDATE leased_line SET total_arrears=201 WHERE id=?').run(line);
  agentMail.send = async () => { throw Object.assign(new Error('授权失效'), { uncertain: false }); };
  const failed = await (await preview()).json();
  assert.equal((await send(failed.id)).status, 502);
  assert.equal(db.prepare('SELECT status FROM warning_mail_delivery WHERE id=?').get(failed.id).status, 'failed');
  assert.equal(db.prepare('SELECT mark FROM line_warning_mark WHERE line_id=?').get(line), undefined);
  db.prepare('UPDATE leased_line SET total_arrears=202 WHERE id=?').run(line);
  agentMail.send = async () => { throw Object.assign(new Error('网络超时'), { uncertain: true }); };
  const uncertain = await (await preview()).json();
  const result = await send(uncertain.id);
  assert.equal(result.status, 502);
  assert.equal((await result.json()).status, 'unknown');
  assert.equal((await send(uncertain.id)).status, 409);
  const retry = await (await preview()).json();
  assert.equal((await send(retry.id)).status, 409);
  db.prepare("DELETE FROM leased_line WHERE group_product_code LIKE 'MAIL-%'").run();
});

test('full group list: import, ledger-first managers, key categories, profile and the strategic fallback', async () => {
  const insert = db.prepare(`INSERT INTO leased_line
    (group_code, group_name, group_product_code, product_name, product_status_name, ledger_status, manager_name, start_time, status_time, package_fee, total_arrears, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const line = (group, code, status, manager, arrears = 0, statusTime = null) =>
    insert.run(group, `台账${group}`, code, '互联网专线', status, status, manager, '2025-03-01', statusTime, 100, arrears, nowIso());
  line('GD001', 'GDL1', '正常在用', '台账经理');
  line('GD001', 'GDL2', '正常在用', '台账经理');
  line('GD001', 'GDL3', '停机', '另一位', 300, '2026-01-01');
  line('GD002', 'GDL4', '正式销户', '李四', 0, '2026-02-01');
  line('GD009', 'GDL5', '正常在用', '赵六');

  const header = ['集团编码', '集团名称', '集团级别', '集团客户经理标识', '集团客户经理名称', '微网格名称', '入网时间', '成员到达数', '企业员工数', '移动成员数', '成员出账金额', '商客战客集团标识', '数据月份'];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([header,
    ['GD001', '清单一', 'A', 'd1', '清单经理', '某微网格', '2004-01-01 00:00:00', '112', '100', '', '12832.72', '战客', '202605']
  ]), '要客清单2');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([header,
    ['GD001', '清单一', 'A', 'd1', '清单经理', '某微网格', '2004-01-01 00:00:00', '112', '100', '', '12832.72', '战客', '202605'],
    ['GD002', '清单二', 'B', 'd2', '李四', '', '2010-05-01 00:00:00', '3', '', '', '', '商客', '202605'],
    ['GD003', '清单三', 'C', 'd3', '王五', '某微网格', '2012-05-01 00:00:00', '9', '20', '9', '59.1', '战客', '202605'],
    ['0GD04', '清单四', 'D', 'd4', '王五', '', '2015-05-01 00:00:00', '1', '', '', '', '商客', '202605'],
    ['GD005', '没有经理', 'D', '', '', '', '', '', '', '', '', '商客', '202605'],
    ['GD001', '重复', 'A', 'd1', '清单经理', '', '', '', '', '', '', '战客', '202605']
  ]), '全量集团');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['集团名称', '集团ID', '客户类别', '客户经理工号', '客户经理姓名'],
    ['清单三', 'GD003', '要客', 'd3', '王五'],
    ['不在清单', 'GDX99', '139要客', 'd9', '某人']
  ]), '要客清单1');
  const upload = async (bytes, name = 'groups.xlsx') => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), name);
    return request('/api/groups/preview', { method: 'POST', body: form });
  };

  assert.equal((await request('/api/groups', {}, false)).status, 401);
  const bad = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(bad, XLSX.utils.aoa_to_sheet([['集团编码', '集团名称'], ['GD001', '清单一']]), 'S');
  const refused = await upload(XLSX.write(bad, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /缺少“集团客户经理名称”列/);

  const preview = await (await upload(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))).json();
  assert.deepEqual(
    [preview.sheetName, preview.rowCount, preview.incomplete, preview.duplicates, preview.keyMatched, preview.keyUnmatched, preview.dataMonth],
    ['全量集团', 4, 1, 1, 1, 1, '202605']
  );
  assert.deepEqual(preview.keySheets, ['要客清单1']);
  assert.deepEqual(preview.ignoredSheets, ['要客清单2']);
  assert.deepEqual([preview.added, preview.removed, preview.replacing, preview.inLedger, preview.ledgerMismatch, preview.strategic], [4, 0, false, 2, 1, 2]);
  assert.equal(preview.ledgerUnlisted >= 1, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM group_directory').get().count, 0, 'a preview changes nothing');

  const committed = await request('/api/groups/commit', { method: 'POST', body: { token: preview.token } });
  assert.equal(committed.status, 200);
  const done = await committed.json();
  assert.match(done.backup, /group-import/);
  assert.equal((await request('/api/groups/commit', { method: 'POST', body: { token: preview.token } })).status, 409);

  const list = async (query) => (await request(`/api/groups?kpiMode=0&${query}`)).json();
  const all = await list('search=GD0');
  const byCode = Object.fromEntries(all.rows.map((row) => [row.groupCode, row]));
  // The ledger's manager wins, by most lines; the list's stays visible and the difference is flagged.
  assert.deepEqual(
    [byCode.GD001.managerName, byCode.GD001.directoryManager, byCode.GD001.managerMismatch, byCode.GD001.activeLines, byCode.GD001.groupName],
    ['台账经理', '清单经理', true, 3, '台账GD001']
  );
  assert.deepEqual([byCode.GD002.managerMismatch, byCode.GD002.activeLines, byCode.GD002.cancelledLines], [false, 0, 1]);
  assert.deepEqual([byCode.GD003.managerName, byCode.GD003.inLedger, byCode.GD003.keyCategory, byCode.GD003.groupName], ['王五', false, '要客', '清单三']);
  assert.equal(byCode['0GD04'].listed, true, 'leading zeros stay');
  assert.deepEqual([byCode.GD009.listed, byCode.GD009.managerName], [false, '赵六']);
  assert.equal(all.rows[0].groupCode, 'GD001', 'groups with lines in service come first');
  assert.equal(all.list.row_count, 4);
  assert.deepEqual((await list('search=GD0&lines=none')).rows.map((row) => row.groupCode).sort(), ['0GD04', 'GD003']);
  assert.deepEqual((await list('search=GD0&lines=inactive')).rows.map((row) => row.groupCode), ['GD002']);
  assert.deepEqual((await list('search=GD0&mark=mismatch')).rows.map((row) => row.groupCode), ['GD001']);
  assert.deepEqual((await list('search=GD0&mark=unlisted')).rows.map((row) => row.groupCode), ['GD009']);
  assert.deepEqual((await list('search=GD0&mark=key')).rows.map((row) => row.groupCode), ['GD003']);
  assert.deepEqual((await list('search=GD0&level=B')).rows.map((row) => row.groupCode), ['GD002']);
  assert.equal((await list('search=王五')).total, 2);
  assert.equal((await request('/api/groups/export?kpiMode=0&search=GD0')).status, 200);

  const profile = await (await request('/api/groups/GD001?kpiMode=0')).json();
  assert.deepEqual([profile.group.managerName, profile.group.level, profile.group.segment, profile.lines.length, profile.group.totalArrears], ['台账经理', 'A', '战客', 3, 300]);
  assert.deepEqual([profile.warnings.length, profile.warnings[0].group_product_code], [1, 'GDL3']);
  assert.deepEqual(profile.statuses.find((item) => item.name === '正常在用'), { name: '正常在用', count: 2 });
  assert.equal(profile.group.more.memberCount, 112);
  const empty = await (await request('/api/groups/GD003?kpiMode=0')).json();
  assert.deepEqual([empty.lines.length, empty.group.inLedger, empty.group.keyCategory], [0, false, '要客']);
  assert.equal((await request('/api/groups/NOPE')).status, 404);

  // With no strategic list imported, the full list's 战客 groups stand in for it.
  const kept = db.prepare('SELECT * FROM strategic_customer').all();
  db.exec('DELETE FROM strategic_customer');
  const fallback = await (await request('/api/strategic?kpiMode=0')).json();
  assert.deepEqual([fallback.from, fallback.list, fallback.summary.total], ['directory', null, 2]);
  const standIn = Object.fromEntries(fallback.groups.map((row) => [row.groupCode, row]));
  assert.deepEqual([standIn.GD001.status, standIn.GD001.managerName, standIn.GD003.status, standIn.GD003.managerName], ['penetrated', '台账经理', 'untouched', '王五']);
  assert.equal((await (await request('/api/groups/GD003?kpiMode=0')).json()).group.strategicStatus, 'untouched');
  assert.equal((await request('/api/strategic/groups/GD001?kpiMode=0')).status, 200);
  const restoreRow = db.prepare('INSERT INTO strategic_customer (group_code, group_name, manager_name, import_id) VALUES (?, ?, ?, ?)');
  for (const row of kept) restoreRow.run(row.group_code, row.group_name, row.manager_name, row.import_id);
  if (kept.length) {
    assert.equal((await (await request('/api/strategic?kpiMode=0')).json()).from, 'strategic');
    assert.equal((await (await request('/api/groups/GD001?kpiMode=0')).json()).group.strategic, false, 'an imported strategic list decides');
  }

  // Every import replaces the whole list.
  const next = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(next, XLSX.utils.aoa_to_sheet([['集团编码', '集团名称', '集团客户经理名称'], ['GD002', '清单二', '新经理']]), '全量集团');
  const second = await (await upload(XLSX.write(next, { type: 'buffer', bookType: 'xlsx' }))).json();
  assert.deepEqual([second.added, second.removed, second.managerChanged, second.replacing], [0, 3, 1, true]);
  assert.equal((await request('/api/groups/commit', { method: 'POST', body: { token: second.token } })).status, 200);
  assert.equal((await request('/api/groups/GD003')).status, 404);
  assert.equal((await (await request('/api/groups/GD001?kpiMode=0')).json()).group.listed, false);

  const scopes = (await (await request('/api/settings/backups')).json()).scopes.map((item) => item.key);
  assert.equal(scopes.includes('groups'), true);

  db.exec("DELETE FROM leased_line WHERE group_product_code LIKE 'GDL%'; DELETE FROM group_directory; DELETE FROM group_directory_import;");
});

test('changing the password needs the current one and a code, and signs out the other sessions', async () => {
  const secret = db.prepare('SELECT totp_secret FROM auth_user WHERE username = ?').get('admin').totp_secret;
  const change = (body, cookie = sessionCookie) => fetch(`${baseUrl}/api/auth/password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body)
  });
  const other = auth.loginAuth({ username: 'admin', password: 'password1', code: totp(secret) }, 'ip:10.9.9.9').cookie.split(';')[0];
  const otherWorks = async () => (await fetch(`${baseUrl}/api/health`, { headers: { Cookie: other } })).status;
  assert.equal(await otherWorks(), 200);

  assert.equal((await fetch(`${baseUrl}/api/auth/password`, { method: 'POST' })).status, 401);
  const short = await change({ currentPassword: 'password1', newPassword: 'short', code: totp(secret) });
  assert.equal(short.status, 400);
  assert.match((await short.json()).error, /至少需要 8 个字符/);
  const wrong = await change({ currentPassword: 'not-it-at-all', newPassword: 'password2', code: totp(secret) });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /当前密码或验证码错误/);
  assert.equal((await change({ currentPassword: 'password1', newPassword: 'password2', code: '000000' })).status, 400);
  const same = await change({ currentPassword: 'password1', newPassword: 'password1', code: totp(secret) });
  assert.match((await same.json()).error, /不能与当前密码相同/);
  assert.equal(await otherWorks(), 200, 'failed attempts end nothing');

  const done = await change({ currentPassword: 'password1', newPassword: 'password2', code: totp(secret) });
  assert.equal(done.status, 200);
  assert.equal((await done.json()).signedOut >= 1, true);
  assert.equal(await otherWorks(), 401, 'other sessions end');
  assert.equal((await request('/api/health')).status, 200, 'the session making the change stays');
  assert.throws(() => auth.loginAuth({ username: 'admin', password: 'password1', code: totp(secret) }, 'ip:10.9.9.8'), /账号、密码或验证码错误/);
  assert.equal(Boolean(auth.loginAuth({ username: 'admin', password: 'password2', code: totp(secret) }, 'ip:10.9.9.8').cookie), true);

  const events = db.prepare("SELECT event FROM security_log WHERE event LIKE 'password_%' ORDER BY id").all().map((row) => row.event);
  assert.deepEqual(events.slice(-3), ['password_change_failed', 'password_change_failed', 'password_changed']);
  const logged = await (await request('/api/settings/security-log?category=account')).json();
  assert.equal(JSON.stringify(logged).includes('password2'), false, 'the log never holds a password');

  // Put the test password back for the tests after this one.
  assert.equal((await change({ currentPassword: 'password2', newPassword: 'password1', code: totp(secret) })).status, 200);
  db.exec("DELETE FROM auth_attempt");
});

test('a manager\'s net figures open into the added and cancelled lines behind them', async () => {
  const insert = db.prepare(`INSERT INTO leased_line
    (group_code, group_name, group_product_code, product_name, product_status_name, ledger_status, manager_name, start_time, status_time, package_fee, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const line = (code, status, start, statusTime, fee) => insert.run('ML001', '明细集团', code, '互联网专线', status, status, '明细经理', start, statusTime, fee, nowIso());
  line('MLL1', '正常在用', '2031-05-10 00:00:00', '2031-05-10 00:00:00', 100);
  line('MLL2', '正常在用', '2031-04-02 00:00:00', '2031-04-02 00:00:00', 200);
  line('MLL3', '正常在用', '2031-01-15 00:00:00', '2031-01-15 00:00:00', 300);
  line('MLL4', '正式销户', '2029-01-01 00:00:00', '2031-05-20 00:00:00', 50);
  line('MLL5', '正式销户', '2031-02-01 00:00:00', '2031-03-01 00:00:00', 60);
  line('MLL6', '临时生成资料', '2031-05-01 00:00:00', '2031-05-01 00:00:00', 70);
  line('MLL7', '正常在用', '2030-12-31 00:00:00', '2030-12-31 00:00:00', 80);

  const query = 'month=2031-05&kpiMode=0';
  const row = (await (await request(`/api/manager-performance?${query}&managers=${encodeURIComponent('明细经理')}`)).json()).rows[0];
  const lines = await (await request(`/api/manager-performance/lines?${query}&manager=${encodeURIComponent('明细经理')}`)).json();
  const codes = (list, period) => list.filter((item) => item.periods.includes(period)).map((item) => item.group_product_code).sort();
  // Every period's list has exactly the lines its count is made of.
  for (const period of ['month', 'quarter', 'year']) {
    assert.equal(codes(lines.added, period).length, row[`${period}_added_count`], `${period} added`);
    assert.equal(codes(lines.cancelled, period).length, row[`${period}_cancelled_count`], `${period} cancelled`);
  }
  assert.deepEqual(codes(lines.added, 'month'), ['MLL1']);
  assert.deepEqual(codes(lines.added, 'quarter'), ['MLL1', 'MLL2']);
  // A line opened and cancelled within the year is in both lists; one never in service is in neither.
  assert.deepEqual(codes(lines.added, 'year'), ['MLL1', 'MLL2', 'MLL3', 'MLL5']);
  assert.deepEqual(codes(lines.cancelled, 'month'), ['MLL4']);
  assert.deepEqual(codes(lines.cancelled, 'year'), ['MLL4', 'MLL5']);
  assert.equal(lines.added[0].group_product_code, 'MLL1', 'newest first');
  assert.equal(lines.added.find((item) => item.group_product_code === 'MLL2').monthly_fee, 200);
  assert.deepEqual((await (await request(`/api/manager-performance/lines?${query}&manager=nobody`)).json()).added, []);
  assert.equal((await request(`/api/manager-performance/lines?${query}&manager=x`, {}, false)).status, 401);
  db.exec("DELETE FROM leased_line WHERE group_product_code LIKE 'MLL%'");
});

test('KPI forecasts find groups on the full group list that have no lines yet', async () => {
  db.exec("DELETE FROM group_directory");
  const add = db.prepare('INSERT INTO group_directory (group_code, group_name, manager_name, segment) VALUES (?, ?, ?, ?)');
  add.run('DIR001', '清单集团一', '清单经理', '商客');
  add.run('KPI001', '清单里的旧名字', '清单经理', '商客');

  const found = await (await request(`/api/kpi/groups?q=${encodeURIComponent('清单集团')}`)).json();
  assert.deepEqual(found, [{ group_code: 'DIR001', group_name: '清单集团一', manager_name: '清单经理', source: 'directory' }]);
  // A group with lines is offered once, as the ledger has it.
  const both = (await (await request('/api/kpi/groups?q=KPI001')).json()).filter((item) => item.group_code === 'KPI001');
  assert.deepEqual(both.map((item) => item.source), ['ledger']);

  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const body = { group_code: 'DIR001', product_type: '互联网专线', kind: 'added', year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, line_count: 2, confidence: 'likely' };
  const created = await request('/api/kpi/forecasts', { method: 'POST', body });
  assert.equal(created.status, 201);
  const forecast = await created.json();
  assert.deepEqual([forecast.group_name, forecast.manager_name], ['清单集团一', '清单经理']);
  const unknown = await request('/api/kpi/forecasts', { method: 'POST', body: { ...body, group_code: 'NOWHERE1' } });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /台账和全量集团清单中都没有该集团/);
  db.prepare('DELETE FROM kpi_forecast WHERE id = ?').run(forecast.id);
  db.exec("DELETE FROM group_directory");
});

test('prospects: groups with no line in service, ranked, per manager, with follow-up marks', async () => {
  db.exec("DELETE FROM group_directory; DELETE FROM group_followup");
  const add = db.prepare('INSERT INTO group_directory (group_code, group_name, manager_name, group_level, segment, key_category, employee_count, member_billing) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  add.run('PR001', '潜客战客', '潜客经理', 'B', '战客', '', 50, 100);
  add.run('PR002', '潜客要客', '潜客经理', 'C', '商客', '要客', 900, null);
  add.run('PR003', '潜客大户', '另一经理', 'A', '商客', '', 5000, 8000);
  add.run('PR004', '潜客小户', '另一经理', 'D', '商客', '', null, null);
  add.run('PR005', '潜客流失', '清单经理', 'A', '商客', '', 10, 10);
  add.run('PR006', '潜客在用', '清单经理', 'A', '战客', '', 10, 10);
  const insert = db.prepare(`INSERT INTO leased_line (group_code, group_name, group_product_code, product_name, product_status_name, ledger_status, manager_name, start_time, status_time, updated_at)
    VALUES (?, ?, ?, '互联网专线', ?, ?, ?, '2025-01-01', '2026-02-01', ?)`);
  insert.run('PR005', '潜客流失', 'PRL1', '正式销户', '正式销户', '台账经理', nowIso());
  insert.run('PR006', '潜客在用', 'PRL2', '正常在用', '正常在用', '台账经理', nowIso());
  // No strategic list of its own here: the full list's 战客 mark decides.
  const kept = db.prepare('SELECT * FROM strategic_customer').all();
  db.exec('DELETE FROM strategic_customer');

  const list = async (query = '') => (await request(`/api/groups/prospects?kpiMode=0&search=PR0${query}`)).json();
  assert.equal((await request('/api/groups/prospects', {}, false)).status, 401);
  const never = await list();
  // Strategic first, then key customers, then by level and size; a missing figure sorts last.
  assert.deepEqual(never.rows.map((row) => row.groupCode), ['PR001', 'PR002', 'PR003', 'PR004']);
  assert.deepEqual([never.rows[3].employeeCount, never.rows[3].memberBilling], [null, null]);
  assert.deepEqual((await list('&sort=employees')).rows.map((row) => row.groupCode), ['PR003', 'PR002', 'PR001', 'PR004']);
  assert.deepEqual((await list('&sort=billing')).rows.map((row) => row.groupCode), ['PR003', 'PR001', 'PR002', 'PR004']);
  assert.deepEqual((await list('&focus=key')).rows.map((row) => row.groupCode), ['PR002']);
  assert.deepEqual((await list('&focus=a')).rows.map((row) => row.groupCode), ['PR003']);
  assert.deepEqual((await list(`&manager=${encodeURIComponent('另一经理')}`)).rows.map((row) => row.groupCode), ['PR003', 'PR004']);
  // A group whose lines are all cancelled is lost, under the ledger's manager; one in service is neither.
  const lost = await list('&type=lost');
  assert.deepEqual(lost.rows.map((row) => [row.groupCode, row.managerName, row.cancelledLines]), [['PR005', '台账经理', 1]]);
  const mine = never.managers.find((row) => row.name === '潜客经理');
  assert.deepEqual([mine.never, mine.neverStrategic, mine.neverKey, mine.neverA, mine.lost], [2, 1, 1, 0, 0]);
  assert.equal(never.managers.find((row) => row.name === '台账经理').lost, 1);
  assert.equal(never.managers[0].name, '潜客经理', 'managers with the most key prospects come first');

  const follow = (code, body) => request(`/api/groups/${code}/followup`, { method: 'PUT', body });
  assert.equal((await follow('PR003', { status: 'nonsense' })).status, 400);
  assert.equal((await follow('NOPE99', { status: 'contacted' })).status, 404);
  assert.equal((await follow('PR003', { status: 'contacted', note: '已约下周拜访' })).status, 200);
  assert.equal((await follow('PR004', { status: 'excluded' })).status, 200);
  const after = await list();
  assert.deepEqual(after.rows.map((row) => row.groupCode), ['PR001', 'PR002', 'PR003'], 'excluded groups leave the list');
  assert.deepEqual([after.rows[2].followStatus, after.rows[2].followNote], ['contacted', '已约下周拜访']);
  assert.deepEqual((await list('&follow=excluded')).rows.map((row) => row.groupCode), ['PR004']);
  assert.deepEqual((await list('&follow=none')).rows.map((row) => row.groupCode), ['PR001', 'PR002']);
  assert.equal(after.summary.never, never.summary.never - 1);
  // The mark survives a replacement of the full list, and clearing it removes the row.
  db.exec("UPDATE group_directory SET import_id = 99");
  assert.equal((await follow('PR003', { status: '', note: '' })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM group_followup WHERE group_code = 'PR003'").get().count, 0);
  assert.equal((await request('/api/groups/prospects/export?kpiMode=0&search=PR0')).status, 200);

  const restore = db.prepare('INSERT INTO strategic_customer (group_code, group_name, manager_name, import_id) VALUES (?, ?, ?, ?)');
  for (const row of kept) restore.run(row.group_code, row.group_name, row.manager_name, row.import_id);
  db.exec("DELETE FROM leased_line WHERE group_product_code LIKE 'PRL%'; DELETE FROM group_directory; DELETE FROM group_followup");
});

test('arrears summary mail: one message per manager, sent by hand, marks its lines', async (t) => {
  const { agentMail } = await import('../server/lib/agent-mail.js');
  t.mock.method(agentMail, 'defaultCc', () => ['audit@example.com']);
  const sent = [];
  t.mock.method(agentMail, 'send', async (report) => { sent.push(report); return { queued: true }; });
  const insert = db.prepare(`INSERT INTO leased_line(group_product_code, group_code, group_name, manager_name, manager_job_no,
    product_name, product_status_name, status_time, total_arrears, start_time) VALUES (?, ?, ?, ?, ?, '互联网专线', ?, ?, ?, ?)`);
  const a1 = Number(insert.run('DG-1', 'DG01', '汇总集团甲', '汇总经理', 'DJ1', '停机', '2026-01-01', 300, '2025-01-01').lastInsertRowid);
  const a2 = Number(insert.run('DG-2', 'DG02', '汇总集团乙', '汇总经理', 'DJ1', '停机', '2026-09-01', 50.5, '2025-01-01').lastInsertRowid);
  const ignored = Number(insert.run('DG-3', 'DG02', '汇总集团乙', '汇总经理', 'DJ1', '停机', '2026-08-01', 70, '2025-01-01').lastInsertRowid);
  const b1 = Number(insert.run('DG-4', 'DG03', '汇总集团丙', '没邮箱经理', 'DJ2', '停机', '2026-07-01', 10, '2025-01-01').lastInsertRowid);
  insert.run('DG-5', 'DG01', '汇总集团甲', '汇总经理', 'DJ1', '正常在用', '2026-10-05', 0, '2026-10-05');
  await request(`/api/warnings/${ignored}`, { method: 'PATCH', body: { mark: 'ignore' } });
  await request('/api/warnings/mail/contacts', { method: 'PUT', body: { key: 'job:DJ1', email: 'manager@example.com' } });

  const preview = async () => (await request('/api/warnings/digest/preview', { method: 'POST', body: { asOf: '2026-10-23', kpiMode: '0' } })).json();
  assert.equal((await request('/api/warnings/digest/preview', { method: 'POST', body: { asOf: 'bad' } })).status, 400);
  const first = await preview();
  const mine = first.managers.find((item) => item.manager === '汇总经理');
  const other = first.managers.find((item) => item.manager === '没邮箱经理');
  assert.deepEqual([mine.lineCount, mine.totalArrears, mine.recipient, mine.problem, Boolean(mine.id)], [2, 350.5, 'manager@example.com', '', true]);
  assert.deepEqual(mine.levels, { cancel: 1, red: 0, yellow: 0, green: 1 });
  assert.deepEqual([other.id, other.problem, other.lineCount], [null, '未设置邮箱', 1]);
  // One message lists every line, most urgent first, and leaves the ignored one out.
  assert.match(mine.subject, /欠费停机预警汇总｜汇总经理｜2 条｜2026-10-23/);
  assert.ok(mine.body.indexOf('DG-1') > 0 && mine.body.indexOf('DG-1') < mine.body.indexOf('DG-2'));
  assert.equal(mine.body.includes('DG-3'), false);
  assert.match(mine.body, /欠费合计 350\.50 元/);
  assert.match(mine.body, /本月（2026-10）：新增 1 条，销户 0 条，净增 \+1 条/);
  assert.equal(sent.length, 0, 'a preview sends nothing');

  const send = (id) => request(`/api/warnings/digest/${id}/send`, { method: 'POST' });
  assert.equal((await send('no-such-id')).status, 400);
  const done = await send(mine.id);
  assert.equal(done.status, 200);
  assert.deepEqual((await done.json()).lineIds.sort(), [a1, a2].sort());
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].recipient, sent[0].cc], ['manager@example.com', ['audit@example.com']]);
  const marks = Object.fromEntries(db.prepare('SELECT line_id, mark FROM line_warning_mark WHERE line_id IN (?, ?, ?, ?)').all(a1, a2, ignored, b1).map((row) => [row.line_id, row.mark]));
  assert.deepEqual(marks, { [a1]: 'remind', [a2]: 'remind', [ignored]: 'ignore' });
  // The same content is not offered twice; a change to the lines makes a new one that can be sent.
  const again = (await preview()).managers.find((item) => item.manager === '汇总经理');
  assert.deepEqual([again.id, again.problem], [null, '相同内容已发送过']);
  db.prepare('UPDATE leased_line SET total_arrears = 301 WHERE id = ?').run(a1);
  const changed = (await preview()).managers.find((item) => item.manager === '汇总经理');
  assert.equal(Boolean(changed.id), true);
  db.prepare('UPDATE leased_line SET total_arrears = 302 WHERE id = ?').run(a1);
  assert.equal((await send(changed.id)).status, 409, 'a stale preview is refused');
  assert.equal(sent.length, 1);
  const history = await (await request('/api/warnings/digest/history')).json();
  assert.deepEqual([history[0].manager_name, history[0].status, history[0].lineCount, history[0].recipient], ['汇总经理', 'queued', 2, 'manager@example.com']);

  db.exec("DELETE FROM line_warning_mark WHERE line_id IN (SELECT id FROM leased_line WHERE group_product_code LIKE 'DG-%'); DELETE FROM leased_line WHERE group_product_code LIKE 'DG-%'; DELETE FROM warning_mail_digest; DELETE FROM warning_mail_contact WHERE manager_key = 'job:DJ1'");
});

test('fill links: one manager fills their own lines and forecasts without an account, within limits, all logged', async () => {
  const insert = db.prepare(`INSERT INTO leased_line (group_code, group_name, group_product_code, product_name, product_status_name, ledger_status, manager_name, start_time, updated_at)
    VALUES (?, ?, ?, '互联网专线', ?, ?, ?, '2025-01-01', ?)`);
  const mine = Number(insert.run('SH001', '填报集团', 'SHL1', '正常在用', '正常在用', '填报经理', nowIso()).lastInsertRowid);
  const cancelled = Number(insert.run('SH001', '填报集团', 'SHL2', '正式销户', '正式销户', '填报经理', nowIso()).lastInsertRowid);
  const theirs = Number(insert.run('SH002', '别人的集团', 'SHL3', '正常在用', '正常在用', '别的经理', nowIso()).lastInsertRowid);
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const forecastBody = { product_type: '互联网专线', kind: 'added', year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, line_count: 3, confidence: 'likely' };
  const myForecast = (await (await request('/api/kpi/forecasts', { method: 'POST', body: { ...forecastBody, group_code: 'SH001' } })).json()).id;
  const theirForecast = (await (await request('/api/kpi/forecasts', { method: 'POST', body: { ...forecastBody, group_code: 'SH002' } })).json()).id;

  // Making a link needs a login; the link itself is then used with no session at all.
  assert.equal((await request('/api/share-links', { method: 'POST', body: { manager: '填报经理', scopes: ['ledger'], days: 3 } }, false)).status, 401);
  assert.equal((await request('/api/share-links', { method: 'POST', body: { manager: '', scopes: ['ledger'], days: 3 } })).status, 400);
  assert.equal((await request('/api/share-links', { method: 'POST', body: { manager: '填报经理', scopes: ['nonsense'], days: 3 } })).status, 400);
  assert.equal((await request('/api/share-links', { method: 'POST', body: { manager: '填报经理', scopes: ['ledger'], days: 99 } })).status, 400);
  const make = async (scopes, days = 3) => (await request('/api/share-links', { method: 'POST', body: { manager: '填报经理', scopes, days, note: '请本周内填完' } })).json();
  const full = await make(['ledger', 'progress', 'report']);
  assert.match(full.path, /^\/fill\/[A-Za-z0-9_-]{43}$/);
  const token = full.path.slice('/fill/'.length);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM share_link WHERE token_hash = ?').get(token).count, 0, 'the token itself is not stored');
  const open = (path = '', options = {}) => request(`/api/fill/${token}${path}`, options, false);

  const page = await (await open()).json();
  assert.deepEqual([page.manager, page.note, page.scopes], ['填报经理', '请本周内填完', ['ledger', 'progress', 'report']]);
  // Only this manager's lines in service, and only this manager's forecasts.
  assert.deepEqual(page.lines.map((line) => line.group_product_code), ['SHL1']);
  assert.deepEqual(page.forecasts.map((item) => item.id), [myForecast]);
  assert.equal(JSON.stringify(page).includes('别人的集团'), false);
  assert.equal((await request('/api/fill/not-a-real-token', {}, false)).status, 404);

  const edit = (id, body, tokenPath = '') => open(`${tokenPath}/lines/${id}`, { method: 'POST', body });
  const saved = await edit(mine, { contract_no: 'HT-2026-001', actual_monthly_fee: '1200', customer_contact: '王工', product_status_name: '正式销户', manager_name: '别的经理' });
  assert.equal(saved.status, 200);
  const after = db.prepare('SELECT contract_no, actual_monthly_fee, customer_contact, product_status_name, manager_name FROM leased_line WHERE id = ?').get(mine);
  // Fields outside the allowed ones are ignored, whatever the request carries.
  assert.deepEqual({ ...after }, { contract_no: 'HT-2026-001', actual_monthly_fee: 1200, customer_contact: '王工', product_status_name: '正常在用', manager_name: '填报经理' });
  const logged = db.prepare("SELECT field_name, changed_by, change_source FROM change_log WHERE leased_line_id = ? ORDER BY id").all(mine);
  assert.deepEqual(logged.map((row) => [row.field_name, row.changed_by, row.change_source]).sort(), [
    ['actual_monthly_fee', '填报链接·填报经理', 'share'], ['contract_no', '填报链接·填报经理', 'share'], ['customer_contact', '填报链接·填报经理', 'share']
  ]);
  assert.equal((await edit(theirs, { contract_no: 'X' })).status, 404, 'another manager\'s line');
  assert.equal(db.prepare('SELECT contract_no FROM leased_line WHERE id = ?').get(theirs).contract_no, null);
  assert.equal((await edit(mine, { contract_start_date: '明天' })).status, 400);
  assert.equal((await edit(mine, { actual_monthly_fee: '-5' })).status, 400);
  assert.equal((await edit(mine, { remark: 'x'.repeat(201) })).status, 400);

  const progress = (id, body) => open(`/forecasts/${id}/progress`, { method: 'POST', body });
  assert.equal((await progress(myForecast, { note: '客户已签合同', landed_count: 1 })).status, 201);
  assert.equal((await progress(myForecast, { note: '' })).status, 400);
  assert.equal((await progress(theirForecast, { note: '不该写进去' })).status, 404);
  const entry = db.prepare('SELECT note, landed_count, created_by FROM kpi_forecast_progress WHERE forecast_id = ? ORDER BY id DESC LIMIT 1').get(myForecast);
  assert.deepEqual({ ...entry }, { note: '客户已签合同', landed_count: 1, created_by: '填报链接·填报经理' });

  // A new forecast is always this manager's, whoever the group's own manager is.
  const reported = await open('/forecasts', { method: 'POST', body: { ...forecastBody, group_code: 'SH002', manager_name: '别的经理', line_count: 2 } });
  assert.equal(reported.status, 201);
  const made = await reported.json();
  assert.deepEqual([made.manager_name, made.group_name, made.created_by], ['填报经理', '别人的集团', '填报链接·填报经理']);
  assert.deepEqual((await (await open(`/groups?q=${encodeURIComponent('填报集')}`)).json()).map((row) => row.group_code), ['SH001']);

  // A link carries only what it was made for.
  const ledgerOnly = (await make(['ledger'])).path.slice(6);
  assert.equal((await request(`/api/fill/${ledgerOnly}/forecasts`, { method: 'POST', body: { ...forecastBody, group_code: 'SH001' } }, false)).status, 403);
  assert.equal((await request(`/api/fill/${ledgerOnly}/forecasts/${myForecast}/progress`, { method: 'POST', body: { note: 'x' } }, false)).status, 403);
  assert.deepEqual((await (await request(`/api/fill/${ledgerOnly}`, {}, false)).json()).forecasts, []);

  // Everything written through the link is on record.
  const submissions = await (await request(`/api/share-links/submissions?link=${full.id}`)).json();
  assert.deepEqual(submissions.map((row) => row.kind).sort(), ['ledger', 'progress', 'report']);
  assert.match(submissions.find((row) => row.kind === 'ledger').summary, /SHL1.*合同编号 空 → HT-2026-001/);
  const listed = (await (await request('/api/share-links')).json()).links.find((item) => item.id === full.id);
  assert.deepEqual([listed.state, listed.submitCount, listed.openCount >= 1, listed.path], ['active', 3, true, undefined]);
  const events = db.prepare("SELECT event FROM security_log WHERE event LIKE 'share_%'").all().map((row) => row.event);
  assert.equal(events.filter((event) => event === 'share_submitted').length, 3);
  assert.equal(events.includes('share_created'), true);

  // Expired and revoked links stop working, for reading and for writing.
  db.prepare('UPDATE share_link SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), full.id);
  assert.equal((await open()).status, 410);
  assert.equal((await edit(mine, { contract_no: 'LATE' })).status, 410);
  assert.equal(db.prepare('SELECT contract_no FROM leased_line WHERE id = ?').get(mine).contract_no, 'HT-2026-001');
  const other = await make(['ledger']);
  assert.equal((await request(`/api/share-links/${other.id}/revoke`, { method: 'POST' })).status, 200);
  const revoked = await request(`/api/fill/${other.path.slice(6)}`, {}, false);
  assert.equal(revoked.status, 410);
  assert.match((await revoked.json()).error, /已被作废/);

  db.exec("DELETE FROM share_submission; DELETE FROM share_link_source; DELETE FROM share_link");
  db.prepare('DELETE FROM kpi_forecast WHERE id IN (?, ?, ?)').run(myForecast, theirForecast, made.id);
  db.prepare('DELETE FROM change_log WHERE leased_line_id IN (?, ?, ?)').run(mine, cancelled, theirs);
  db.exec("DELETE FROM leased_line WHERE group_product_code LIKE 'SHL%'");
});

test('fill links by mail: each manager gets their own link, with no copies, and failures leave no stray link', async (t) => {
  const { agentMail } = await import('../server/lib/agent-mail.js');
  const sent = [];
  let failure = null;
  t.mock.method(agentMail, 'defaultCc', () => ['audit@example.com']);
  t.mock.method(agentMail, 'send', async (message) => { if (failure) throw failure; sent.push(message); return { queued: true }; });
  const insert = db.prepare(`INSERT INTO leased_line (group_code, group_name, group_product_code, product_name, product_status_name, manager_name, manager_job_no, updated_at)
    VALUES ('SM001', '邮件集团', ?, '互联网专线', '正常在用', ?, ?, ?)`);
  insert.run('SML1', '邮件经理甲', 'SJ1', nowIso());
  insert.run('SML2', '邮件经理乙', '', nowIso());
  insert.run('SML3', '没邮箱经理乙', 'SJ3', nowIso());
  await request('/api/warnings/mail/contacts', { method: 'PUT', body: { key: 'job:SJ1', email: 'jia@example.com' } });
  await request('/api/warnings/mail/contacts', { method: 'PUT', body: { key: 'name:邮件经理乙', email: 'yi@example.com' } });

  const listed = await (await request('/api/share-links')).json();
  assert.deepEqual([listed.emails['邮件经理甲'], listed.emails['邮件经理乙'], listed.emails['没邮箱经理乙']], ['jia@example.com', 'yi@example.com', undefined]);

  const send = (manager, extra = {}) => request('/api/share-links/send', { method: 'POST', body: { manager, scopes: ['ledger', 'progress'], days: 7, note: '请周五前填完', origin: 'https://ledger.example.com:3443', ...extra } });
  assert.equal((await request('/api/share-links/send', { method: 'POST', body: { manager: '邮件经理甲', scopes: ['ledger'], days: 7, origin: 'https://x' } }, false)).status, 401);
  assert.equal((await send('邮件经理甲', { origin: 'javascript:alert(1)' })).status, 400);
  const noAddress = await send('没邮箱经理乙');
  assert.equal(noAddress.status, 400);
  assert.match((await noAddress.json()).error, /还没有设置 没邮箱经理乙 的邮箱/);
  assert.equal((await send('邮件经理甲', { scopes: [] })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM share_link').get().count, 0, 'a refused request makes no link');

  const first = await send('邮件经理甲');
  assert.equal(first.status, 201);
  const made = await first.json();
  assert.deepEqual([made.recipient, made.sentTo, made.state, made.path], ['jia@example.com', 'jia@example.com', 'active', undefined]);
  assert.equal((await send('邮件经理乙')).status, 201);
  assert.deepEqual(sent.map((message) => [message.recipient, message.copy, message.cc]), [['jia@example.com', false, undefined], ['yi@example.com', false, undefined]]);
  // The mailed link is that manager's own and works.
  const link = /https:\/\/ledger\.example\.com:3443\/fill\/([A-Za-z0-9_-]{43})/.exec(sent[0].body);
  assert.ok(link, 'the message carries the link');
  assert.match(sent[0].subject, /专线填报链接｜邮件经理甲｜有效期至 /);
  assert.match(sent[0].body, /台账补充信息、商机进度/);
  assert.match(sent[0].body, /说明：请周五前填完/);
  const page = await (await request(`/api/fill/${link[1]}`, {}, false)).json();
  assert.deepEqual([page.manager, page.lines.map((line) => line.group_product_code)], ['邮件经理甲', ['SML1']]);
  assert.notEqual(link[1], /fill\/([A-Za-z0-9_-]{43})/.exec(sent[1].body)[1], 'each manager has a different link');

  // A message that certainly did not go out leaves no link behind; an unknown result keeps it.
  failure = Object.assign(new Error('授权失效'), { uncertain: false });
  const failed = await send('邮件经理甲');
  assert.equal(failed.status, 502);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM share_link').get().count, 2);
  failure = Object.assign(new Error('网络超时'), { uncertain: true });
  const unknown = await send('邮件经理甲');
  assert.deepEqual([unknown.status, (await unknown.json()).status], [502, 'unknown']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM share_link WHERE sent_to IS NULL').get().count, 1);
  failure = null;
  const logged = db.prepare("SELECT detail FROM security_log WHERE event = 'share_created' ORDER BY id DESC LIMIT 4").all().map((row) => row.detail);
  assert.equal(logged.some((detail) => /已邮件发送至 jia@example\.com/.test(detail)), true);
  assert.equal(JSON.stringify(logged).includes(link[1]), false, 'the log never holds a link');

  db.exec("DELETE FROM share_link_source; DELETE FROM share_link; DELETE FROM leased_line WHERE group_product_code LIKE 'SML%'; DELETE FROM warning_mail_contact WHERE manager_key IN ('job:SJ1', 'name:邮件经理乙')");
});

test('the arrears summary can carry the manager\'s own fill link', async (t) => {
  const { agentMail } = await import('../server/lib/agent-mail.js');
  t.mock.method(agentMail, 'defaultCc', () => ['audit@example.com']);
  const sent = [];
  let failure = null;
  t.mock.method(agentMail, 'send', async (message) => { if (failure) throw failure; sent.push(message); return { queued: true }; });
  const insert = db.prepare(`INSERT INTO leased_line(group_product_code, group_code, group_name, manager_name, manager_job_no,
    product_name, product_status_name, status_time, total_arrears, start_time) VALUES (?, 'DL01', '附链集团', '附链经理', 'DLJ', '互联网专线', '停机', '2026-06-01', ?, '2025-01-01')`);
  insert.run('DL-1', 100);
  await request('/api/warnings/mail/contacts', { method: 'PUT', body: { key: 'job:DLJ', email: 'dl@example.com' } });
  const preview = async () => (await request('/api/warnings/digest/preview', { method: 'POST', body: { asOf: '2026-10-23', kpiMode: '0' } })).json();
  const send = (id, body) => request(`/api/warnings/digest/${id}/send`, { method: 'POST', body });
  const mine = (data) => data.managers.find((item) => item.manager === '附链经理');

  const first = await preview();
  assert.deepEqual(first.fillLink, { days: 7, scopes: ['台账补充信息', '商机进度'], base: '' });
  // A bad address makes no link and sends nothing; the preview can still be sent.
  const refused = await send(mine(first).id, { withLink: true, origin: 'not-a-url' });
  assert.equal(refused.status, 400);
  assert.deepEqual([sent.length, db.prepare('SELECT COUNT(*) AS count FROM share_link').get().count], [0, 0]);
  // A send that certainly failed leaves no link behind.
  failure = Object.assign(new Error('授权失效'), { uncertain: false });
  assert.equal((await send(mine(first).id, { withLink: true, origin: 'https://ledger.example.com:3443' })).status, 502);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM share_link').get().count, 0);
  failure = null;

  db.prepare("UPDATE leased_line SET total_arrears = 120 WHERE group_product_code = 'DL-1'").run();
  const done = await send(mine(await preview()).id, { withLink: true, origin: 'https://ledger.example.com:3443' });
  assert.equal(done.status, 200);
  assert.equal((await done.json()).withLink, true);
  const link = /https:\/\/ledger\.example\.com:3443\/fill\/([A-Za-z0-9_-]{43})/.exec(sent[0].body);
  assert.ok(link, 'the summary ends with the link');
  assert.ok(sent[0].body.indexOf('欠费合计') < sent[0].body.indexOf(link[0]), 'after the arrears lines');
  const page = await (await request(`/api/fill/${link[1]}`, {}, false)).json();
  assert.deepEqual([page.manager, page.scopes, page.lines.map((line) => line.group_product_code)], ['附链经理', ['ledger', 'progress'], ['DL-1']]);
  const stored = db.prepare('SELECT manager_name, sent_to FROM share_link').all().map((row) => ({ ...row }));
  assert.deepEqual(stored, [{ manager_name: '附链经理', sent_to: 'dl@example.com' }]);

  // Without the option the summary is as before and no link is made.
  db.prepare("UPDATE leased_line SET total_arrears = 130 WHERE group_product_code = 'DL-1'").run();
  assert.equal((await send(mine(await preview()).id, {})).status, 200);
  assert.equal(sent[1].body.includes('/fill/'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM share_link').get().count, 1);

  db.exec("DELETE FROM share_link_source; DELETE FROM share_link; DELETE FROM warning_mail_digest; DELETE FROM line_warning_mark WHERE line_id IN (SELECT id FROM leased_line WHERE group_product_code LIKE 'DL-%'); DELETE FROM leased_line WHERE group_product_code LIKE 'DL-%'; DELETE FROM warning_mail_contact WHERE manager_key = 'job:DLJ'");
});

test('the fill port serves fill links and nothing else, and mailed links use its public address', async (t) => {
  const { agentMail } = await import('../server/lib/agent-mail.js');
  const sent = [];
  t.mock.method(agentMail, 'send', async (message) => { sent.push(message); return { queued: true }; });
  const net = await import('node:net');
  const freePort = () => new Promise((resolve) => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  const fillPort = serverModule.fillPort;
  fillPort.configure({ tls: null, host: '127.0.0.1', reservedPorts: [listener.address().port] });
  const secret = db.prepare('SELECT totp_secret FROM auth_user WHERE username = ?').get('admin').totp_secret;
  const save = (body) => request('/api/settings/fill-port', { method: 'PUT', body: { code: totp(secret), ...body } });
  db.prepare(`INSERT INTO leased_line (group_code, group_name, group_product_code, product_name, product_status_name, manager_name, manager_job_no, updated_at)
    VALUES ('FP001', '端口集团', 'FPL1', '互联网专线', '正常在用', '端口经理', 'FPJ', ?)`).run(nowIso());
  await request('/api/warnings/mail/contacts', { method: 'PUT', body: { key: 'job:FPJ', email: 'fp@example.com' } });

  // Off by default; changing it needs a login and the authenticator code.
  const before = await (await request('/api/settings/fill-port')).json();
  assert.deepEqual([before.settings.enabled, before.listener.running], [false, false]);
  assert.equal((await request('/api/settings/fill-port', {}, false)).status, 401);
  const port = await freePort();
  assert.equal((await request('/api/settings/fill-port', { method: 'PUT', body: { code: '000000', enabled: true, port, publicUrl: 'https://fill.example.com:9443' } })).status, 403);
  assert.equal((await save({ enabled: true, port: 80, publicUrl: 'https://fill.example.com' })).status, 400);
  assert.equal((await save({ enabled: true, port: listener.address().port, publicUrl: 'https://fill.example.com' })).status, 400, 'the main port is taken');
  assert.equal((await save({ enabled: true, port, publicUrl: '' })).status, 400, 'an address is needed to mail links');
  assert.equal((await save({ enabled: true, port, publicUrl: 'https://fill.example.com/some/path' })).status, 400);
  assert.equal(fillPort.status().running, false);
  db.exec("DELETE FROM auth_attempt");

  const opened = await save({ enabled: true, port, publicUrl: 'https://fill.example.com:9443/' });
  assert.equal(opened.status, 200);
  assert.deepEqual([(await opened.json()).listener.port, fillPort.readSettings().publicUrl], [port, 'https://fill.example.com:9443']);
  const outside = (path, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, options);

  // Nothing of the system is on this port: not the pages, not the login, not any other API.
  for (const path of ['/', '/index.html', '/api/health', '/api/auth/status', '/api/ledger', '/api/share-links', '/api/settings/fill-port', '/api/groups', '/fill/', '/assets/../index.html']) {
    assert.equal((await outside(path)).status, 404, path);
  }
  assert.equal((await outside('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await outside('/api/ledger', { headers: { Cookie: sessionCookie } })).status, 404, 'a real session opens nothing here either');
  const unknown = await outside('/api/fill/not-a-real-token');
  assert.deepEqual([unknown.status, unknown.headers.get('referrer-policy'), unknown.headers.get('x-powered-by')], [404, 'no-referrer', null]);

  // A mailed link starts with the public address, and works through the port.
  const mailed = await request('/api/share-links/send', { method: 'POST', body: { manager: '端口经理', scopes: ['ledger'], days: 3, origin: 'https://10.0.0.5:3443' } });
  assert.equal(mailed.status, 201);
  const link = /https:\/\/fill\.example\.com:9443\/fill\/([A-Za-z0-9_-]{43})/.exec(sent[0].body);
  assert.ok(link, 'the public address, not the one the sender was using');
  assert.equal((await (await request('/api/share-links')).json()).linkBase, 'https://fill.example.com:9443');
  const page = await outside(`/api/fill/${link[1]}`);
  assert.equal(page.status, 200);
  assert.deepEqual((await page.json()).lines.map((line) => line.group_product_code), ['FPL1']);
  const lineId = db.prepare("SELECT id FROM leased_line WHERE group_product_code = 'FPL1'").get().id;
  const filled = await outside(`/api/fill/${link[1]}/lines/${lineId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contract_no: 'FP-1' }) });
  assert.equal(filled.status, 200);
  assert.equal(db.prepare('SELECT contract_no FROM leased_line WHERE id = ?').get(lineId).contract_no, 'FP-1');
  const tooBig = await outside(`/api/fill/${link[1]}/lines/${lineId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remark: 'x'.repeat(100000) }) });
  assert.equal(tooBig.status, 413);
  const shell = await outside(`/fill/${link[1]}`);
  assert.equal([200, 404].includes(shell.status), true, 'the page itself, where the client has been built');

  // Closing it takes effect at once, and links go back to the sender's own address.
  assert.equal((await save({ enabled: false, port, publicUrl: 'https://fill.example.com:9443' })).status, 200);
  await assert.rejects(outside('/api/fill/x'));
  assert.equal((await (await request('/api/share-links')).json()).linkBase, '');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM security_log WHERE event = 'fill_port_changed'").get().count, 2);

  db.exec("DELETE FROM share_submission; DELETE FROM share_link_source; DELETE FROM share_link; DELETE FROM fill_port_settings; DELETE FROM change_log WHERE leased_line_id IN (SELECT id FROM leased_line WHERE group_product_code = 'FPL1'); DELETE FROM leased_line WHERE group_product_code = 'FPL1'; DELETE FROM warning_mail_contact WHERE manager_key = 'job:FPJ'; DELETE FROM auth_attempt");
});

test('an authenticator code works once: a second use is refused everywhere and logged', async () => {
  const secret = db.prepare('SELECT totp_secret FROM auth_user WHERE username = ?').get('admin').totp_secret;
  db.prepare('UPDATE auth_user SET totp_last_step = NULL').run();
  const code = totpRaw(secret);
  // Used to sign in...
  assert.equal(Boolean(auth.loginAuth({ username: 'admin', password: 'password1', code }, 'ip:10.7.0.1').cookie), true);
  // ...it cannot sign in again, confirm a setting, or change the password.
  assert.throws(() => auth.loginAuth({ username: 'admin', password: 'password1', code }, 'ip:10.7.0.2'), /这个验证码已经用过/);
  assert.throws(() => auth.verifyUserCode('admin', code, 'ip:10.7.0.2'), (error) => error.status === 403 && /已经用过/.test(error.message));
  const settings = await request('/api/settings/fill-port', { method: 'PUT', body: { code, enabled: false, port: 9443, publicUrl: '' } });
  assert.equal(settings.status, 403);
  assert.match((await settings.json()).error, /已经用过/);
  const password = await request('/api/auth/password', { method: 'POST', body: { currentPassword: 'password1', newPassword: 'password9', code } });
  assert.match((await password.json()).error, /已经用过/);
  assert.equal(Boolean(auth.loginAuth({ username: 'admin', password: 'password1', code: totp(secret) }, 'ip:10.7.0.3').cookie), true, 'the password did not change');
  // An older code is refused once a newer one has been used.
  db.prepare('UPDATE auth_user SET totp_last_step = NULL').run();
  assert.equal(auth.verifyUserCode('admin', totpRaw(secret), 'ip:10.7.0.4'), true);
  assert.throws(() => auth.verifyUserCode('admin', totpRaw(secret, Date.now() - 30000), 'ip:10.7.0.4'), /已经用过/);
  // A reused code is not a wrong one: it does not count towards the lockout, and a wrong
  // password never uses the code up.
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_attempt WHERE attempt_key LIKE '%10.7.0.%'").get().count, 0);
  db.prepare('UPDATE auth_user SET totp_last_step = NULL').run();
  const fresh = totpRaw(secret);
  assert.throws(() => auth.loginAuth({ username: 'admin', password: 'wrong-password', code: fresh }, 'ip:10.7.0.5'), /账号、密码或验证码错误/);
  assert.equal(Boolean(auth.loginAuth({ username: 'admin', password: 'password1', code: fresh }, 'ip:10.7.0.5').cookie), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM security_log WHERE event = 'code_reused'").get().count >= 4, true);
  db.exec("DELETE FROM auth_attempt");
});

test('every response carries the security headers and no other site may call the API', async () => {
  for (const path of ['/api/health', '/api/auth/status', '/api/ledger?page=1', '/api/fill/none']) {
    const response = await request(path);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'/, path);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(response.headers.get('x-powered-by'), null, path);
    assert.equal(response.headers.get('access-control-allow-origin'), null, path);
  }
  assert.equal((await request('/api/ledger?page=1')).headers.get('referrer-policy'), 'same-origin');
  assert.equal((await request('/api/fill/none')).headers.get('referrer-policy'), 'no-referrer');
  // A browser's cross-site preflight gets no permission to go on.
  const preflight = await request('/api/ledger', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PATCH' } });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  assert.equal(preflight.headers.get('access-control-allow-methods'), null);
  const { securityHeaders } = await import('../server/lib/fill-port.js');
  assert.equal(securityHeaders(true)['Strict-Transport-Security'], 'max-age=15552000');
  assert.equal(securityHeaders(false)['Strict-Transport-Security'], undefined);
  db.exec("DELETE FROM security_log WHERE event = 'share_bad_token'");
});

test('odd use of fill links is logged, and the next login is told what happened', async () => {
  db.exec("DELETE FROM security_log WHERE event LIKE 'share_%'");
  const secret = db.prepare('SELECT totp_secret FROM auth_user WHERE username = ?').get('admin').totp_secret;
  // The login that the summary counts from, and the one doing the looking.
  auth.loginAuth({ username: 'admin', password: 'password1', code: totp(secret) }, 'ip:10.8.0.1');
  const events = (name) => db.prepare('SELECT source, username, detail FROM security_log WHERE event = ? ORDER BY id').all(name).map((row) => ({ ...row }));
  db.prepare(`INSERT INTO leased_line (group_code, group_name, group_product_code, product_name, product_status_name, manager_name, updated_at)
    VALUES ('AU001', '审计集团', 'AUL1', '互联网专线', '正常在用', '审计经理', ?)`).run(nowIso());
  const made = await (await request('/api/share-links', { method: 'POST', body: { manager: '审计经理', scopes: ['ledger'], days: 3 } })).json();
  const token = made.path.slice(6);
  const openFrom = (ip) => { db.prepare('UPDATE share_link_source SET source = ? WHERE link_id = ? AND source LIKE ?').run(`ip:${ip}`, made.id, 'ip:%127.0.0.1'); return request(`/api/fill/${token}`, {}, false); };

  // The first address is routine, a few more are noted, more than that is flagged.
  await request(`/api/fill/${token}`, {}, false);
  await request(`/api/fill/${token}`, {}, false);
  assert.deepEqual(events('share_opened').map((row) => [row.username, row.detail]), [['填报链接·审计经理', '首次打开']]);
  await openFrom('10.1.1.1');
  await openFrom('10.1.1.2');
  assert.equal(events('share_opened_new').length, 2);
  assert.equal(events('share_opened_many').length, 0);
  await openFrom('10.1.1.3');
  assert.deepEqual(events('share_opened_many').map((row) => row.detail), ['从新的地址打开，此前已有 3 个不同地址']);
  assert.equal((await (await request('/api/share-links')).json()).links.find((link) => link.id === made.id).sourceCount, 4);

  // An expired link being tried is logged once, not on every click.
  db.prepare('UPDATE share_link SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), made.id);
  for (let index = 0; index < 3; index += 1) assert.equal((await request(`/api/fill/${token}`, {}, false)).status, 410);
  assert.deepEqual(events('share_denied').map((row) => row.detail), ['使用已过期的链接']);

  // Wrong tokens are each on record, and the one that trips the limit is logged as a block.
  serverModule.shareService.resetLimits();
  db.exec("DELETE FROM security_log WHERE event IN ('share_bad_token', 'share_blocked')");
  let statuses = [];
  for (let index = 0; index < 22; index += 1) statuses.push((await request(`/api/fill/wrong-token-${index}`, {}, false)).status);
  assert.deepEqual([statuses.filter((status) => status === 404).length, statuses.filter((status) => status === 429).length], [20, 2]);
  assert.equal(events('share_bad_token').length, 20);
  assert.equal(events('share_blocked').length, 1);
  assert.match(events('share_blocked')[0].detail, /连续 20 次无效链接，15 分钟内不再响应/);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM security_log WHERE event LIKE 'share_%'").all()).includes(token), false, 'no token in the log');

  // Signing in again shows what happened since the login before.
  auth.loginAuth({ username: 'admin', password: 'password1', code: totp(secret) }, 'ip:10.8.0.1');
  assert.equal((await request('/api/settings/security-log/summary', {}, false)).status, 401);
  const summary = await (await request('/api/settings/security-log/summary')).json();
  const counts = Object.fromEntries(summary.items.map((item) => [item.event, item.count]));
  assert.deepEqual([counts.share_bad_token, counts.share_blocked, counts.share_denied, counts.share_opened_many, counts.share_opened], [20, 1, 1, 1, undefined]);
  assert.equal(summary.total >= 23, true);
  assert.ok(summary.since && summary.latestId > 0);
  // After one more login with nothing in between, there is nothing to report.
  auth.loginAuth({ username: 'admin', password: 'password1', code: totp(secret) }, 'ip:10.8.0.1');
  auth.loginAuth({ username: 'admin', password: 'password1', code: totp(secret) }, 'ip:10.8.0.1');
  assert.deepEqual((await (await request('/api/settings/security-log/summary')).json()).items, []);
  const log = await (await request('/api/settings/security-log?category=share')).json();
  assert.equal(log.rows.some((row) => row.event === 'share_blocked'), true);

  serverModule.shareService.resetLimits();
  db.exec("DELETE FROM share_link_source; DELETE FROM share_link; DELETE FROM leased_line WHERE group_product_code = 'AUL1'; DELETE FROM auth_attempt");
});

test('logout invalidates the session cookie', async () => {
  const response = await request('/api/auth/logout', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  const denied = await request('/api/health');
  assert.equal(denied.status, 401);
});
