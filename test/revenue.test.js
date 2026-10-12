import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import XLSX from 'xlsx';
import express from 'express';
import { schemaSql } from '../server/lib/schema.js';
import { toCents, netCents, productTaxRate, comparison, validMonth } from '../server/lib/revenue-money.js';
import { parseRevenueWorkbook } from '../server/lib/revenue-import.js';
import { createRevenueStore } from '../server/lib/revenue-store.js';
import { createRevenueRouter } from '../server/lib/revenue.js';
import { estimateLine } from '../server/lib/revenue-report.js';

function fixture(overrides = {}) {
  return { 月份: 202609, 集团编码: '001', 集团名称: '测试集团', 集团客户经理ID: 'M1', 集团客户经理: '张凯', 客户ID: 'C1',
    产品大类ID: 'HLZX', 产品大类名称: '互联网专线', 政企分类产品: '专线', 出账金额: '109', 税费: '9', 调账金额: '0', 调账税费: '0', 计算后信息化收入: 100, ...overrides };
}
function workbook(rows, name = 'BOSS') {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), name);
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
function context(t) {
  const directory = mkdtempSync(join(tmpdir(), 'revenue-tests-'));
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); db.exec(schemaSql);
  const leasedLineSource = (query) => String(query.kpiMode ?? '1') !== '0' ? "(SELECT * FROM leased_line WHERE product_name = '互联网专线')" : 'leased_line';
  const store = createRevenueStore({ db, uploadDir: directory, leasedLineSource });
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const load = (rows) => { const result = store.preview(workbook(rows), '测试收入.xlsx', 'tester'); store.commit(result.id, { replace: true }, 'tester'); return result; };
  return { db, store, load, directory, leasedLineSource };
}
const service = (extra = {}) => ({ requestId: randomUUID(), groupCode: '001', month: '2026-09', name: '专线延伸服务', grossAmount: '106',
  coverage: 'excluded', confirmed: true, frequency: 'once', endMonth: null, sourceRowId: null, remark: '合同确认', ...extra });

test('income decimal arithmetic, configured taxes and comparison boundaries', () => {
  assert.equal(toCents('.99'), 99); assert.equal(toCents('-.995'), -100); assert.equal(toCents('1,090.00'), 109000);
  assert.equal(toCents(1e-8), 0); assert.equal(toCents('', '金额', true), 0);
  for (const value of ['bad', '1,00', Infinity, {}, '1e1000', '99999999999999999999']) assert.throws(() => toCents(value));
  assert.equal(netCents(109000, 9), 100000); assert.equal(netCents(106000, 6), 100000); assert.equal(netCents(-106, 6), -100);
  assert.equal(productTaxRate('专线卫士'), 6); assert.equal(productTaxRate('省内专线卫士'), 6); assert.equal(productTaxRate('专线延伸服务'), 6);
  assert.equal(productTaxRate('新增其他产品'), 9); assert.equal(productTaxRate('非专线卫士产品'), 9); assert.equal(productTaxRate(''), null);
  assert.equal(comparison(100, null).change, null); assert.equal(comparison(100, 0).changeRate, null); assert.equal(comparison(100, -100).changeRate, null);
  assert.equal(comparison(11000, 10000).changeRate, .1); assert.throws(() => validMonth('2026-13'));
});

test('billing status, month boundaries, fee fallback and one-time taxes stay consistent', () => {
  const line = { product_name: '互联网专线', product_status_name: '正常在用', actual_monthly_fee: 109, package_fee: 218, one_time_fee: 109, start_time: '2026-09-03' };
  assert.deepEqual(estimateLine(line, '2026-09'), { gross: 21800, net: 20000, rate: 9, oneTime: 10900 });
  assert.equal(estimateLine(line, '2026-10').gross, 10900);
  assert.equal(estimateLine({ ...line, actual_monthly_fee: 0 }, '2026-10').gross, 21800);
  assert.equal(estimateLine({ ...line, actual_monthly_fee: -10 }, '2026-10').gross, 21800);
  for (const state of ['停机', '停机执行中']) {
    assert.equal(estimateLine({ ...line, product_status_name: state, status_time: '2026-09-20' }, '2026-09').net, 20000);
    assert.equal(estimateLine({ ...line, product_status_name: state, status_time: '2026-08-20' }, '2026-09').net, 0);
  }
  for (const state of ['正式销户', '欠费销户', '临时生成资料']) assert.equal(estimateLine({ ...line, product_status_name: state }, '2026-09').gross, 0);
});

test('import preserves negative revenue, unknown categories, no-group repeated rows and raw identifiers', (t) => {
  const { store, load } = context(t);
  const rows = [fixture(), fixture({ 集团编码: '002', 计算后信息化收入: -10, 政企分类产品: '', 产品大类ID: 'A' }),
    fixture({ 集团编码: '', 计算后信息化收入: 5 }), fixture({ 集团编码: '', 计算后信息化收入: 5 })];
  const preview = load(rows);
  assert.equal(preview.fileName, '测试收入.xlsx'); assert.equal(preview.months[0].rowCount, 4);
  assert.equal(preview.months[0].totalRevenue, 90); assert.equal(preview.months[0].ungroupedRevenue, 10);
  const result = store.summary({ month: '2026-09' });
  assert.equal(result.summary.totalRevenue, 90); assert.equal(result.summary.ungroupedRevenue, 10);
  assert.equal(result.summary.previousRevenue, null); assert.equal(result.managers[0].groupCount, 2);
  assert.equal(store.detail('001', { month: '2026-09' }).sourceRows[0].raw.客户ID, 'C1');
  assert.equal(store.detail('002', { month: '2026-09' }).products[0].category, '未分类');
  const repeated = store.preview(workbook(rows), '重命名.xlsx', 'tester');
  assert.equal(repeated.duplicate, true); assert.throws(() => store.commit(repeated.id, { replace: true }, 'tester'), /已经导入/);
});

test('revisions are atomic, preserve trace-only corrections, reject stale preview and retain old batches', (t) => {
  const { store, load, db } = context(t); load([fixture()]);
  const correction = store.preview(workbook([fixture({ 客户ID: 'C2' })]), '修订.xlsx', 'tester');
  assert.equal(correction.duplicate, false); assert.equal(correction.months[0].previousRevenue, 100);
  store.commit(correction.id, { replace: true }, 'tester');
  assert.equal(store.detail('001', { month: '2026-09' }).sourceRows[0].raw.客户ID, 'C2');
  const old = store.preview(workbook([fixture({ 计算后信息化收入: 200 })]), '版本一.xlsx', 'tester');
  const fresh = store.preview(workbook([fixture({ 计算后信息化收入: 300 })]), '版本二.xlsx', 'tester');
  assert.throws(() => store.commit(fresh.id, { replace: true }, 'someone-else'), /本人/);
  assert.throws(() => store.commit(fresh.id, {}, 'tester'), /明确确认/);
  store.commit(fresh.id, { replace: true }, 'tester');
  assert.throws(() => store.commit(old.id, { replace: true }, 'tester'), /失效/);
  assert.equal(store.summary({ month: '2026-09' }).summary.totalRevenue, 300);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM revenue_batch_month WHERE active = 1').get().n, 1);
  assert.equal(store.meta().batches.filter((batch) => batch.status === 'committed').length, 3);
});

test('missing prior periods, manager transfers and KPI preserve actual income denominators', (t) => {
  const { store, load, db } = context(t);
  load([fixture({ 月份: 202608, 集团客户经理ID: 'OLD', 集团客户经理: '原经理', 计算后信息化收入: 80 }), fixture()]);
  db.prepare('INSERT INTO leased_line(group_code, product_name, product_status_name, package_fee) VALUES(?,?,?,?)').run('001', '互联网专线', '正常在用', 109);
  db.prepare('INSERT INTO leased_line(group_code, product_name, product_status_name, package_fee) VALUES(?,?,?,?)').run('001', '省内专线卫士', '正常在用', 106);
  const kpi = store.summary({ month: '2026-09', kpiMode: '1' });
  const all = store.summary({ month: '2026-09', kpiMode: '0' });
  assert.equal(kpi.summary.totalRevenue, all.summary.totalRevenue); assert.equal(kpi.groups[0].currentLineCount, 1); assert.equal(all.groups[0].currentLineCount, 2);
  assert.equal(all.groups[0].managerChanged, true); assert.equal(all.groups[0].change, 20); assert.equal(all.managers[0].previousRevenue, null);
  assert.equal(store.summary({ month: '2026-09', managers: 'none' }).groups.length, 0);
  assert.equal(store.summary({ month: '2026-07' }).summary.totalRevenue, null);
  const detail = store.detail('001', { month: '2026-09', kpiMode: '0' });
  assert.equal(detail.reconciliation.netEstimate, 200); assert.equal(detail.reconciliation.status, 'insufficient'); assert.equal(detail.reconciliation.difference, null);
  assert.equal(detail.trend.length, 2); assert.equal(store.detail('001', { month: '2026-07' }).group.hasReport, false);
});

test('service confirmations, idempotent retries, revisions, version checks and soft-delete prevent double counting', (t) => {
  const { store, load, db } = context(t); load([fixture()]);
  const input = service();
  const added = store.saveService(null, input, 'tester');
  assert.equal(added.revenue, 100); assert.equal(store.saveService(null, input, 'tester').id, added.id);
  assert.equal(store.summary({ month: '2026-09' }).summary.totalRevenue, 200);
  assert.equal(store.summary({ month: '2026-09' }).summary.lineRevenue, 100);
  assert.throws(() => store.saveService(null, { ...input, grossAmount: 212 }, 'tester'), /已经处理/);
  const included = store.saveService(null, service({ coverage: 'included' }), 'tester');
  store.saveService(null, service({ coverage: 'pending', confirmed: false }), 'tester');
  assert.equal(store.summary({ month: '2026-09' }).summary.totalRevenue, 200);
  assert.throws(() => store.saveService(added.id, input, 'tester'), /版本/);
  const revision = load([fixture({ 客户ID: 'CORRECTION' })]);
  assert.equal(store.summary({ month: '2026-09' }).summary.totalRevenue, 100);
  const updated = store.detail('001', { month: '2026-09' }).services.find((row) => row.id === added.id);
  assert.equal(updated.needsReview, true);
  assert.throws(() => store.saveService(added.id, { ...input, version: added.version }, 'tester'), /已被修改/);
  assert.throws(() => store.saveService(null, input, 'tester'), /已经处理/);
  const confirmed = store.saveService(added.id, { ...input, version: updated.version }, 'tester');
  assert.equal(confirmed.confirmedBatchId, revision.id); assert.equal(store.summary({ month: '2026-09' }).summary.totalRevenue, 200);
  assert.throws(() => store.deleteService(added.id, 'tester'), /版本/);
  store.deleteService(added.id, 'tester', confirmed.version);
  assert.equal(store.summary({ month: '2026-09' }).summary.totalRevenue, 100);
  assert.equal(db.prepare('SELECT deleted FROM revenue_service WHERE id=?').get(added.id).deleted, 1);
  assert.ok(store.detail('001', { month: '2026-09' }).audit.length > 5);
  assert.ok(included.id);
});

test('service source ownership, future estimates, pending status and settings validation', (t) => {
  const { store, load } = context(t); load([fixture(), fixture({ 月份: 202610 })]);
  const row = store.detail('001', { month: '2026-09' }).sourceRows[0];
  const input = service({ coverage: 'included', sourceRowId: row.id, frequency: 'monthly', endMonth: '2026-12' });
  const entry = store.saveService(null, input, 'tester');
  assert.equal(store.saveService(null, input, 'tester').id, entry.id);
  assert.throws(() => store.saveService(null, { ...input, requestId: randomUUID() }, 'tester'), /已关联/);
  const future = store.detail('001', { month: '2026-10' });
  assert.equal(future.services[0].projected, true); assert.equal(future.reconciliation.projectedServiceNet, 100);
  assert.equal(future.group.totalRevenue, 100);
  assert.throws(() => store.saveService(null, service({ coverage: 'pending' }), 'tester'), /不能确认/);
  assert.throws(() => store.saveService(null, service({ sourceRowId: row.id }), 'tester'), /不能绑定/);
  assert.throws(() => store.saveService(null, service({ coverage: 'included', sourceRowId: 999 }), 'tester'), /来源行/);
  assert.throws(() => store.saveService(null, service({ groupCode: 'missing' }), 'tester'), /无报表/);
  assert.throws(() => store.saveService(null, service({ month: '2026-11' }), 'tester'), /无有效报表/);
  assert.throws(() => store.settings({ tolerance: -1 }, 'tester'), /负数/);
  assert.equal(store.settings({ tolerance: '.05' }, 'tester').tolerance, .05);
});

test('invalid workbook inputs fail clearly without relying on filename month', () => {
  const missing = fixture(); delete missing.月份;
  assert.throws(() => parseRevenueWorkbook(workbook([missing])), /缺少必要字段/);
  assert.throws(() => parseRevenueWorkbook(workbook([fixture({ 月份: 'wrong' })])), /月份无效/);
  assert.throws(() => parseRevenueWorkbook(workbook([fixture({ 计算后信息化收入: '' })])), /不能为空/);
  assert.throws(() => parseRevenueWorkbook(workbook([fixture(), fixture({ 集团客户经理ID: 'M2' })])), /多个客户经理/);
});

test('included extension service reconciliation respects source category and unknown coverage', (t) => {
  const { store, load, db } = context(t);
  load([fixture(), fixture({ 产品大类ID: 'SERVICE', 产品大类名称: '专线延伸服务', 政企分类产品: '其他', 出账金额: 106, 税费: 6 })]);
  db.prepare('INSERT INTO leased_line(group_code, product_name, product_status_name, package_fee) VALUES(?,?,?,?)').run('001', '互联网专线', '正常在用', 109);
  const detail = store.detail('001', { month: '2026-09' });
  const sourceRow = detail.sourceRows.find((row) => row.productId === 'SERVICE');
  store.saveService(null, service({ coverage: 'included', sourceRowId: sourceRow.id }), 'tester');
  const after = store.detail('001', { month: '2026-09' });
  assert.equal(after.group.totalRevenue, 200);
  assert.equal(after.reconciliation.referenceDifference, 0);
  store.saveService(null, service({ coverage: 'included', sourceRowId: null }), 'tester');
  assert.equal(store.detail('001', { month: '2026-09' }).reconciliation.referenceDifference, null);
});

test('income HTTP routes expose validation errors and preserve authenticated actor audit', async (t) => {
  const { db, directory, leasedLineSource } = context(t);
  const app = express();
  app.use((req, res, next) => { req.user = { username: 'tester' }; next(); });
  app.use('/api/revenue', createRevenueRouter({ db, uploadDir: directory, leasedLineSource }));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/revenue`;
  try {
    assert.equal((await fetch(base + '/meta')).status, 200);
    const form = new FormData(); form.append('file', new Blob([workbook([fixture()])]), '测试收入.xlsx');
    const preview = await (await fetch(base + '/imports/preview', { method: 'POST', body: form })).json();
    assert.equal(preview.fileName, '测试收入.xlsx');
    const send = (path, method, body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send(`/imports/${preview.id}/commit`, 'POST', { replace: true })).status, 200);
    assert.equal((await fetch(base + '/groups/001?month=2026-09')).status, 200);
    assert.equal((await fetch(base + '/summary?month=invalid')).status, 400);
    const saved = await (await send('/services', 'POST', service())).json();
    assert.equal(saved.createdBy, 'tester');
    assert.equal((await send(`/services/${saved.id}`, 'DELETE', { version: saved.version })).status, 200);
    assert.equal((await fetch(base + '/imports/preview', { method: 'POST' })).status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
