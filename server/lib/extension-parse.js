// Reading a 专线延伸 filing request out of an email. The wording varies from mail to mail, so each
// field is looked for on its own, and anything not found is left empty for a person to fill in
// before saving. Nothing here guesses: a figure is either read from the text or missing.

const chineseDigits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** Plain text from a mail body that may be HTML. */
export function mailText(body, format = '') {
  let text = String(body ?? '');
  if (/html/i.test(format) || /<(?:p|div|br|span|table|td|font)\b/i.test(text)) {
    text = text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&amp;/gi, '&');
  }
  return text.replace(/\r\n?/g, '\n').replace(/[ \t 　]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const amount = (value) => {
  const raw = String(value ?? '').replace(/[,，\s]/g, '');
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
};
const first = (text, patterns) => {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return '';
};
const money = (text, labels) => amount(first(text, labels.map((label) => new RegExp(`${label}\\s*[：:为是]?\\s*(?:人民币)?\\s*([\\d][\\d,，]*(?:\\.\\d+)?)\\s*元`))));

/**
 * Tiers like “数据专线延伸服务档次二150元/次，15次”. Each gives its name, its price per time,
 * how many times, and the product of the two.
 */
export function parseTiers(text) {
  const tiers = [];
  // The level is a Chinese numeral, or digits set apart from the price that follows them
  // (档次2：100元 or 档次 2 100元); 档次2100元 would be ambiguous and is not read as a level.
  const pattern = /([^；;。\n]*?档次\s*([一二三四五六七八九十]+|\d+(?=\s*[：:])|\d+(?=\s)))\s*[：:]?\s*([\d.]+)\s*元\s*[/／每]\s*次\s*[，,、x×*＊]?\s*(?:共\s*)?(\d+)\s*次/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1].replace(/^.*[：:]/, '').replace(/^[，,、\s]+/, '').trim();
    const level = /^\d+$/.test(match[2]) ? Number(match[2]) : chineseDigits[match[2]] ?? null;
    const price = amount(match[3]);
    const times = Number(match[4]);
    tiers.push({ name, level, price, times, subtotal: price === null ? null : Math.round(price * times * 100) / 100 });
  }
  return tiers;
}

/** Every field the ledger keeps, read from the mail text, with what could not be read or does not add up. */
export function parseExtensionMail(raw) {
  const text = mailText(raw);
  const flat = text.replace(/\s+/g, ' ');
  const groupCode = first(flat, [/集团编码\s*[：:]?\s*(\d{6,})/, /集团(?:代码|编号|ID)\s*[：:]?\s*(\d{6,})/i]);
  const groupName = first(flat, [
    /集团客户\s*[：:]?\s*([^，,。；;：:\s]{2,80}?)\s*[，,（(]\s*集团编码/,
    /客户\s*[：:]?\s*([^，,。；;：:\s]{2,80}?)\s*[，,（(]\s*集团编码/,
    /集团名称\s*[：:]\s*([^，,。；;\s]{2,80})/
  ]);
  const managerName = first(flat, [
    /项目责任人\s*[：:]?\s*(?:客户经理|经理)?\s*[：:]?\s*([一-龥·]{2,6}?)(?=[，,。；;、\s]|$)/,
    /客户经理\s*[：:]?\s*([一-龥·]{2,6}?)(?=[，,。；;、\s]|$)/
  ]);
  const deliverer = first(flat, [/由\s*([^，,。；;\s]{1,40}?)\s*(?:负责)?执行交付/, /交付(?:商|单位)\s*[：:为是]?\s*([^，,。；;\s]{1,40})/]);
  const profit = first(flat, [/利润(?:率)?\s*[：:为是]?\s*([\d.]+)\s*[%％]/]);
  const discount = first(flat, [/折扣\s*[：:为是]?\s*([\d.]+)\s*[%％]/]);
  const tiers = parseTiers(flat);
  const draft = {
    group_code: groupCode,
    group_name: groupName,
    manager_name: managerName,
    contract_amount: money(flat, ['合同金额']),
    billing_amount: money(flat, ['总出账价格', '总出账金额', '出账金额', '出账价格']),
    presale_amount: money(flat, ['售前确认书金额', '售前确认金额']),
    discount: discount === '' ? null : Number(discount),
    profit_rate: profit === '' ? null : Number(profit),
    deliverer,
    tiers
  };

  const labels = { group_code: '集团编码', group_name: '集团名称', manager_name: '客户经理', contract_amount: '合同金额', billing_amount: '出账金额', presale_amount: '售前确认书金额', deliverer: '交付商' };
  const missing = Object.entries(labels).filter(([key]) => draft[key] === '' || draft[key] === null).map(([, label]) => label);
  if (!tiers.length) missing.push('订购资费档次');
  const warnings = [];
  const tierTotal = tiers.length ? Math.round(tiers.reduce((sum, tier) => sum + (tier.subtotal ?? 0), 0) * 100) / 100 : null;
  const afterDiscount = tierTotal === null ? null : Math.round(tierTotal * ((draft.discount ?? 100) / 100) * 100) / 100;
  if (afterDiscount !== null && draft.billing_amount !== null && Math.abs(afterDiscount - draft.billing_amount) > 0.01) {
    warnings.push(`各档次合计 ${afterDiscount} 元（折扣后），与出账金额 ${draft.billing_amount} 元不一致`);
  }
  if (draft.contract_amount !== null && draft.billing_amount !== null && Math.abs(draft.contract_amount - draft.billing_amount) > 0.01) {
    warnings.push(`合同金额 ${draft.contract_amount} 元与出账金额 ${draft.billing_amount} 元不一致`);
  }
  return { draft, text, missing, warnings, tierTotal };
}
