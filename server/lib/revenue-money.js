export class RevenueError extends Error {}

export function fail(message) { throw new RevenueError(message); }

export function safeCents(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) fail('金额超出可安全计算范围');
  return result;
}

export function roundRatio(numerator, denominator) {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute * 2n + denominator) / (denominator * 2n);
  return safeCents(negative ? -rounded : rounded);
}

// Decimal input is never multiplied as a binary float. Ties round away from zero.
export function toCents(value, label = '金额', blankAsZero = false) {
  if (value === null || value === undefined || String(value).trim() === '') {
    if (blankAsZero) return 0;
    fail(`${label}不能为空`);
  }
  if (!['number', 'string'].includes(typeof value)) fail(`${label}格式无效`);
  let text = String(value).trim();
  text = text.replace(/^([+-]?)\./, '$10.');
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replaceAll(',', '');
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || text.length > 100) fail(`${label}格式无效`);
  const exponent = Number(match[4] || 0) - (match[3] || '').length + 2;
  if (Math.abs(exponent) > 100) fail(`${label}超出范围`);
  let integer = BigInt(match[2] + (match[3] || '')) * (match[1] === '-' ? -1n : 1n);
  return exponent >= 0
    ? safeCents(integer * 10n ** BigInt(exponent))
    : roundRatio(integer, 10n ** BigInt(-exponent));
}

export function addCents(...values) {
  return safeCents(values.reduce((total, value) => total + BigInt(value), 0n));
}

export function netCents(gross, rate) {
  if (rate !== 6 && rate !== 9) fail('税率必须明确为 6% 或 9%');
  return roundRatio(BigInt(gross) * 100n, BigInt(100 + rate));
}

export const money = (cents) => cents === null ? null : cents / 100;
export const share = (part, total) => total > 0 ? part / total : null;

export function comparison(current, previous) {
  const change = current === null || previous === null ? null : addCents(current, -previous);
  return { previousRevenue: money(previous), change: money(change), changeRate: previous > 0 && change !== null ? change / previous : null };
}

export function validMonth(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value)) fail('月份格式应为 YYYY-MM');
  return value;
}

export function previousMonth(month) {
  validMonth(month);
  const [year, number] = month.split('-').map(Number);
  return number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, '0')}`;
}

export const productTaxRates = new Map([
  ['专线卫士', 6], ['省内专线卫士', 6], ['专线延伸服务', 6],
  ...['互联网专线', '数据专线', '数据专线（跨省）', '数据专线(跨省)',
    '传输专线', 'OTN政企专网', '跨省互联网专线', '国际政企专网专线',
    '新跨省专线产品', 'SPN专线', 'MPLS VPN专线', '跨国专线A类产品',
    '跨省专线产品', 'IMS语音专线'].map((name) => [name, 9])
]);

export function productTaxRate(name) {
  const normalized = String(name ?? '').trim();
  return normalized ? productTaxRates.get(normalized) ?? 9 : null;
}
