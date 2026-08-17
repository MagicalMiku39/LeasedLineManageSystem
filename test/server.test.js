import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';

const tempDir = mkdtempSync(join(tmpdir(), 'ledger-tests-'));
process.env.LEDGER_DB_PATH = join(tempDir, 'test.db');

const { db, makeBatchId, nowIso } = await import('../server/lib/db.js');
const auth = await import('../server/lib/auth.js');
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

test('logout invalidates the session cookie', async () => {
  const response = await request('/api/auth/logout', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  const denied = await request('/api/health');
  assert.equal(denied.status, 401);
});
