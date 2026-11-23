import { netCents, toCents } from './revenue-money.js';

/**
 * 专线延伸服务 revenue, as 集团收入 counts it: a project's 出账金额 (tax included, 6%) is billed in
 * full in its 出账月份 and counts as 专线收入 of that group, under the line product it belongs to
 * (数据专线 or 互联网专线). A month counts only once its revenue report is imported, and a group
 * whose report for that month already has a 延伸服务 row keeps the report's figure instead.
 */
export const extensionTaxRate = 6;

export const extensionNetCents = (billingAmount) => netCents(toCents(billingAmount, '出账金额'), extensionTaxRate);

const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/** Projects billed in the given months that can be counted: they have a group, an amount and a month. */
export function extensionRevenueRows(db, months) {
  if (!months.length || !tableExists(db, 'line_extension')) return [];
  return db.prepare(`SELECT id, group_code, group_name, manager_name, billing_amount, billing_month, line_type FROM line_extension
    WHERE billing_month IN (${months.map(() => '?').join(', ')}) AND billing_amount IS NOT NULL AND COALESCE(group_code, '') <> ''
    ORDER BY billing_month, id`).all(...months)
    .map((row) => ({
      id: row.id, groupCode: row.group_code, groupName: row.group_name, managerName: row.manager_name, month: row.billing_month,
      lineType: row.line_type || null, grossCents: toCents(row.billing_amount, '出账金额'), netCents: extensionNetCents(row.billing_amount)
    }));
}

/** Months with an active revenue report. */
export function reportMonths(db) {
  if (!tableExists(db, 'revenue_batch_month')) return new Set();
  return new Set(db.prepare('SELECT month FROM revenue_batch_month WHERE active = 1').all().map((row) => row.month));
}

/** "month|group" for each group whose active report for that month already has a 延伸服务 row. */
export function reportedExtensionPairs(db, months) {
  if (!months.length || !tableExists(db, 'revenue_source_row')) return new Set();
  return new Set(db.prepare(`SELECT DISTINCT r.month, r.group_code FROM revenue_source_row r
    JOIN revenue_batch_month b ON b.batch_id = r.batch_id AND b.month = r.month AND b.active = 1
    WHERE r.month IN (${months.map(() => '?').join(', ')}) AND json_extract(r.data_json, '$.productName') LIKE '%延伸%'`).all(...months)
    .map((row) => `${row.month}|${row.group_code}`));
}
