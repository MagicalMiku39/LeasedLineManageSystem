import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filtersToSearchParams,
  money,
  netClass,
  signedMoney,
  signedNumber
} from '../client/src/utils.js';
import { blobToBase64, saveFile, saveWorkbook, xlsxType } from '../client/src/saveFile.js';
import XLSX from 'xlsx';

test('inside the Android app a file made in the page goes straight to the app, bytes intact', async () => {
  const received = [];
  const app = { LedgerApp: { saveBase64: (name, type, base64) => received.push({ name, type, base64 }) } };
  const bytes = new Uint8Array(70000).map((_, index) => index % 256);
  assert.equal(await saveFile(new Blob([bytes], { type: 'application/x-pkcs12' }), '张三手机.p12', app), 'app');
  assert.equal(received.length, 1);
  assert.deepEqual([received[0].name, received[0].type], ['张三手机.p12', 'application/x-pkcs12']);
  assert.deepEqual(new Uint8Array(Buffer.from(received[0].base64, 'base64')), bytes, 'every byte, past one chunk');
  assert.equal(await blobToBase64(new Blob([])), '');

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([{ 集团编码: '0012', 金额: 1.5 }]), '表');
  assert.equal(await saveWorkbook(XLSX, book, 'KPI达成-2026.xlsx', app), 'app');
  assert.deepEqual([received[1].name, received[1].type], ['KPI达成-2026.xlsx', xlsxType]);
  const back = XLSX.read(Buffer.from(received[1].base64, 'base64'), { type: 'buffer' });
  assert.deepEqual(XLSX.utils.sheet_to_json(back.Sheets['表'], { raw: false }), [{ 集团编码: '0012', 金额: '1.5' }]);
});

test('number formatters handle positive, negative, zero and empty values', () => {
  assert.equal(money(1234.5), '1,234.50');
  assert.equal(money(null), '0.00');
  assert.equal(signedNumber(12), '+12');
  assert.equal(signedNumber(-12), '-12');
  assert.equal(signedMoney(12.5), '+12.50');
  assert.equal(signedMoney(-12.5), '-12.50');
  assert.equal(netClass(1), 'net-positive');
  assert.equal(netClass(-1), 'net-negative');
  assert.equal(netClass(0), 'net-zero');
});

test('filtersToSearchParams serializes active filters and preserves extra params', () => {
  const params = filtersToSearchParams({
    keyword: ' Acme ',
    region: ['East', 'West'],
    status: [],
    zeroBilling: '',
    page: 0
  }, { page: 2, kpiMode: '1' });

  assert.equal(params.get('keyword'), ' Acme ');
  assert.equal(params.get('region'), 'East|West');
  assert.equal(params.get('page'), '2');
  assert.equal(params.get('kpiMode'), '1');
  assert.equal(params.has('status'), false);
  assert.equal(params.has('zeroBilling'), false);
});
