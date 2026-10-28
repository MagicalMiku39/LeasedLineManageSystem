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
  assert.deepEqual(overview.months, [11, 12]);
  assert.equal(overview.actual.added, stats.addedInCurrentYear);
  assert.equal(overview.actual.cancelled, stats.cancelledInCurrentYear);
  assert.equal(overview.actual.net, stats.addedInCurrentYear - stats.cancelledInCurrentYear);
  const zhang = overview.managers.find((row) => row.manager_name === '张凯');
  assert.ok(zhang.added >= 2);
  assert.equal(zhang.net, zhang.added - zhang.cancelled);
  assert.equal(overview.forecast.added, 0);

  const groups = await (await request('/api/kpi/groups?q=KPI00')).json();
  assert.deepEqual(groups.find((row) => row.group_code === 'KPI001'), { group_code: 'KPI001', group_name: 'Kpi Group', manager_name: '张凯' });
  assert.deepEqual(await (await request('/api/kpi/groups?q=')).json(), []);

  const invalid = [
    { group_code: '', product_type: '互联网专线', line_count: 1, month: 11 },
    { group_code: 'KPI001', product_type: '不存在', line_count: 1, month: 11 },
    { group_code: 'KPI001', product_type: '互联网专线', line_count: 1, month: 10 },
    { group_code: 'KPI001', product_type: '互联网专线', line_count: 0, month: 12 },
    { group_code: 'NEW999', product_type: '互联网专线', line_count: 1, month: 12, group_name: '' }
  ];
  for (const body of invalid) {
    assert.equal((await request('/api/kpi/forecasts', { method: 'POST', body })).status, 400);
  }

  // A known group takes the ledger's name and manager, whatever the form sent.
  const known = await request('/api/kpi/forecasts', {
    method: 'POST', body: { group_code: 'KPI001', group_name: 'typed', manager_name: '王倩', product_type: '互联网专线', line_count: 3, month: 11 }
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
  assert.deepEqual(next.forecast.byMonth, { 11: { added: 3, cancelled: 0 }, 12: { added: 2, cancelled: 1 } });
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

  assert.equal((await request(`/api/kpi/forecasts/${freshRow.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request(`/api/kpi/forecasts/${freshRow.id}`, { method: 'DELETE' })).status, 404);
  next = await (await request('/api/kpi?kpiMode=1')).json();
  assert.equal(next.forecast.added, 0);
  assert.equal(next.forecast.cancelled, 1);
  assert.equal(next.forecasts.length, 2);
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

test('logout invalidates the session cookie', async () => {
  const response = await request('/api/auth/logout', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  const denied = await request('/api/health');
  assert.equal(denied.status, 401);
});
