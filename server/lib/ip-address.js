import { isIPv4, isIPv6 } from 'node:net';

/**
 * IP addresses kept by hand on a line. A field may hold several, separated by commas, spaces,
 * semicolons or new lines, each optionally with a prefix length (10.1.1.1/30, 240e:1::1/64).
 * Returns { value } — the addresses joined by "、", or null when empty — or { error }.
 */
export function cleanAddresses(raw, version) {
  const text = String(raw ?? '').trim();
  if (!text) return { value: null };
  if (text.length > 500) return { error: `IPv${version} 地址不能超过 500 字` };
  const items = text.split(/[\s,，;；、]+/).filter(Boolean);
  const valid = version === 4 ? isIPv4 : isIPv6;
  const maxPrefix = version === 4 ? 32 : 128;
  for (const item of items) {
    const [address, prefix, extra] = item.split('/');
    const prefixOk = prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= maxPrefix);
    if (extra !== undefined || !valid(address) || !prefixOk) return { error: `“${item}”不是有效的 IPv${version} 地址` };
  }
  return { value: [...new Set(items)].join('、') };
}

export const ipFields = { ipv4_address: 4, ipv6_address: 6 };
