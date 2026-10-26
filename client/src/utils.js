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

export const emptyMark = '—';

export function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

// Missing values read as a dash; a real zero is printed.
export function displayValue(value) {
  return isBlank(value) ? emptyMark : value;
}

// Amount cells: two decimals with separators. Text that is not a number is shown as entered.
export function displayMoney(value) {
  if (isBlank(value)) return emptyMark;
  const number = Number(value);
  return Number.isFinite(number) ? money(number) : String(value);
}

// Controlled inputs: keep 0, turn null or undefined into an empty field.
export function inputValue(value) {
  return value ?? '';
}

// Calendar date and month in Beijing time, the business day used across the system.
export function beijingDate(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function beijingMonth(date = new Date()) {
  return beijingDate(date).slice(0, 7);
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
