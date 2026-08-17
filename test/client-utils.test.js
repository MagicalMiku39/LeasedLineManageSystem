import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filtersToSearchParams,
  money,
  netClass,
  signedMoney,
  signedNumber
} from '../client/src/utils.js';

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
