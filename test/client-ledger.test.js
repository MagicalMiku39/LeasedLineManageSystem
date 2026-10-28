import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, requestJson } from '../client/src/api.js';
import { kpiManagerRows } from '../client/src/kpiRows.js';
import { advancedFilterKeys, defaultManagers, defaultVisibleColumns, emptyFilters, tableColumns } from '../client/src/ledger/config.js';
import {
  moveColumn,
  normalizeColumnOrder,
  normalizeVisibleColumns,
  readStoredJson,
  toggleKey,
  writeStoredJson
} from '../client/src/ledger/columnSettings.js';
import {
  countActiveFilters,
  filtersForStat,
  followStatMonth,
  ledgerExportQuery,
  ledgerPeriodExportQuery,
  ledgerListQuery
} from '../client/src/ledger/query.js';
import { beijingDate, beijingMonth, displayMoney, displayValue, inputValue } from '../client/src/utils.js';

const sort = { key: 'group_code', direction: 'asc' };

test('ledger list and export queries carry the same filters, sort and KPI scope; export has no paging', () => {
  const filters = { ...emptyFilters, keyword: '0270', region: ['江岸一区', '江岸二区'], statFilter: 'addedInMonth', statMonth: '2026-10' };
  const list = new URLSearchParams(ledgerListQuery(filters, { page: 3, pageSize: 20, sort, kpiMode: false }));
  const exported = new URLSearchParams(ledgerExportQuery(filters, { sort, kpiMode: false }));

  assert.equal(list.get('page'), '3');
  assert.equal(list.get('pageSize'), '20');
  assert.equal(exported.has('page'), false);
  assert.equal(exported.has('pageSize'), false);
  for (const params of [list, exported]) {
    assert.equal(params.get('keyword'), '0270');
    assert.equal(params.get('region'), '江岸一区|江岸二区');
    assert.equal(params.get('statFilter'), 'addedInMonth');
    assert.equal(params.get('statMonth'), '2026-10');
    assert.equal(params.get('sortBy'), 'group_code');
    assert.equal(params.get('sortDirection'), 'asc');
    assert.equal(params.get('kpiMode'), '0');
  }
  assert.equal(new URLSearchParams(ledgerExportQuery(emptyFilters, { sort, kpiMode: true })).get('kpiMode'), '1');
});

test('KPI manager rows keep all 18 managers with zeros and skip landed forecasts', () => {
  const managers = [{ manager_name: '张凯', added: 5, cancelled: 1 }, { manager_name: 'Other', added: 2, cancelled: 0 }];
  const forecasts = [
    { manager_name: '张凯', kind: 'added', line_count: 3, landed: false },
    { manager_name: '张凯', kind: 'cancelled', line_count: 2, landed: false },
    { manager_name: '张凯', kind: 'added', line_count: 9, landed: true },
    { manager_name: 'Newcomer', kind: 'added', line_count: 1, landed: false }
  ];
  const defaults = kpiManagerRows(managers, forecasts, 'defaults');
  assert.equal(defaults.length, defaultManagers.length);
  assert.deepEqual(defaults[0], {
    manager_name: '张凯', added: 5, cancelled: 1, net: 4, forecastAdded: 3, forecastCancelled: 2, expectedNet: 5
  });
  assert.ok(defaults.slice(1).every((row) => row.added === 0 && row.net === 0));
  assert.ok(!defaults.some((row) => row.manager_name === 'Other'));

  const all = kpiManagerRows(managers, forecasts, 'all');
  assert.deepEqual(all.map((row) => row.manager_name), ['张凯', 'Other', 'Newcomer']);
  assert.equal(all[2].expectedNet, 1);
});

test('year and quarter export queries carry only the period and the KPI scope', () => {
  assert.equal(ledgerPeriodExportQuery('quarter', true), 'period=quarter&kpiMode=1');
  assert.equal(ledgerPeriodExportQuery('year', false), 'period=year&kpiMode=0');
  assert.equal(new URLSearchParams(ledgerPeriodExportQuery('anything', true)).get('period'), 'year');
});

test('statistic filters replace other filters and only month-scoped ones follow the month', () => {
  assert.deepEqual(filtersForStat(emptyFilters, '', '2026-10'), emptyFilters);
  const stat = filtersForStat(emptyFilters, 'cancelledInMonth', '2026-10');
  assert.equal(stat.statFilter, 'cancelledInMonth');
  assert.equal(stat.statMonth, '2026-10');
  assert.equal(stat.keyword, '');

  assert.equal(followStatMonth(stat, '2026-11').statMonth, '2026-11');
  const keywordOnly = { ...emptyFilters, keyword: 'x' };
  assert.equal(followStatMonth(keywordOnly, '2026-11'), keywordOnly);
  const active = filtersForStat(emptyFilters, 'active', '2026-10');
  assert.equal(followStatMonth(active, '2026-11'), active);

  assert.equal(countActiveFilters({ ...emptyFilters, groupCode: '001', statFilter: 'active' }, advancedFilterKeys), 2);
});

test('column settings survive damaged storage and keep new columns', () => {
  const keys = tableColumns.map((column) => column.key);
  const broken = { getItem: () => '{not json', setItem() { throw new Error('quota'); } };
  assert.equal(readStoredJson(broken, 'k'), null);
  assert.doesNotThrow(() => writeStoredJson(broken, 'k', [1]));

  assert.deepEqual(normalizeVisibleColumns(null, keys, defaultVisibleColumns), defaultVisibleColumns);
  assert.deepEqual(normalizeVisibleColumns({}, keys, defaultVisibleColumns), defaultVisibleColumns);
  assert.deepEqual(normalizeVisibleColumns([], keys, defaultVisibleColumns), []);
  assert.deepEqual(normalizeVisibleColumns(['group_name', 'removed_column'], keys, defaultVisibleColumns), ['group_name']);

  const order = normalizeColumnOrder(['remark', 'group_code', 'gone'], keys);
  assert.deepEqual(order.slice(0, 2), ['remark', 'group_code']);
  assert.equal(order.length, keys.length);
  assert.deepEqual(new Set(order), new Set(keys));

  assert.deepEqual(moveColumn(['a', 'b', 'c'], 'c', 'a', false), ['c', 'a', 'b']);
  assert.deepEqual(moveColumn(['a', 'b', 'c'], 'a', 'c', true), ['b', 'c', 'a']);
  assert.deepEqual(moveColumn(['a', 'b', 'c'], 'a', 'a', true), ['a', 'b', 'c']);
  assert.deepEqual(toggleKey(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleKey(['a', 'b'], 'a'), ['b']);
});

test('codes stay text columns and amounts are the only money columns', () => {
  const money = tableColumns.filter((column) => column.money).map((column) => column.key).sort();
  assert.deepEqual(money, ['actual_monthly_fee', 'actual_yearly_fee', 'one_time_fee', 'package_fee', 'total_arrears']);
  for (const key of ['group_code', 'group_product_code', 'product_code', 'manager_job_no', 'one_time_fee_name']) {
    assert.equal(tableColumns.find((column) => column.key === key).money, undefined);
  }
});

test('display helpers print zero, dash missing values and keep codes untouched', () => {
  assert.equal(displayValue(0), 0);
  assert.equal(displayValue('0027'), '0027');
  assert.equal(displayValue(null), '—');
  assert.equal(displayValue('  '), '—');
  assert.equal(displayMoney(0), '0.00');
  assert.equal(displayMoney('2350'), '2,350.00');
  assert.equal(displayMoney(-12.5), '-12.50');
  assert.equal(displayMoney(undefined), '—');
  assert.equal(displayMoney('待定'), '待定');
  assert.equal(inputValue(0), 0);
  assert.equal(inputValue(null), '');
  assert.equal(beijingDate(new Date('2026-10-31T16:30:00Z')), '2026-11-01');
  assert.equal(beijingMonth(new Date('2026-10-31T16:30:00Z')), '2026-11');
});

test('requestJson explains network, format and status failures', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const respond = (status, body) => async () => new Response(body, { status });

  globalThis.fetch = respond(200, '{"ok":true}');
  assert.deepEqual(await requestJson('/x'), { ok: true });

  globalThis.fetch = respond(200, '');
  assert.equal(await requestJson('/x'), null);

  globalThis.fetch = respond(401, '{"error":"账号、密码或验证码错误"}');
  await assert.rejects(requestJson('/auth/login'), { message: '账号、密码或验证码错误', status: 401 });

  globalThis.fetch = respond(401, '{"error":"未登录"}');
  await assert.rejects(requestJson('/ledger'), { message: '登录已过期，请重新登录', status: 401 });

  globalThis.fetch = respond(400, '{"error":"没有可更新字段"}');
  await assert.rejects(requestJson('/ledger/1'), { message: '没有可更新字段' });

  globalThis.fetch = respond(502, '<html>Bad gateway</html>');
  await assert.rejects(requestJson('/ledger'), { message: '请求失败（502）' });

  globalThis.fetch = respond(200, '<!doctype html>');
  await assert.rejects(requestJson('/ledger'), /接口返回格式异常/);

  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(requestJson('/ledger'), (error) => error instanceof ApiError && error.status === 0);

  globalThis.fetch = async () => { throw new DOMException('aborted', 'AbortError'); };
  await assert.rejects(requestJson('/ledger'), { name: 'AbortError' });
});
