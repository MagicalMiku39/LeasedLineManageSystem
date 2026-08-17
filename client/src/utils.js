export function money(value) {
  const number = Number(value || 0);
  return number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function signedNumber(value) {
  const number = Number(value || 0);
  return `${number > 0 ? '+' : ''}${number.toLocaleString('zh-CN')}`;
}

export function signedMoney(value) {
  const number = Number(value || 0);
  return `${number > 0 ? '+' : ''}${money(number)}`;
}

export function netClass(value) {
  const number = Number(value || 0);
  if (number > 0) return 'net-positive';
  if (number < 0) return 'net-negative';
  return 'net-zero';
}

export function filtersToSearchParams(filters, extra = {}) {
  const params = new URLSearchParams(extra);
  Object.entries(filters).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join('|'));
    } else if (value) {
      params.set(key, value);
    }
  });
  return params;
}
