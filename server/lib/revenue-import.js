import XLSX from 'xlsx';
import { createHash } from 'node:crypto';
import { addCents, fail, money, netCents, productTaxRate, toCents, validMonth } from './revenue-money.js';

const fields = {
  month: ['月份', '收入所属月', '收入月份'],
  groupCode: ['集团编码'], groupName: ['集团名称'],
  managerId: ['集团客户经理ID', '集团客户经理id', '集团客户经理Id'],
  managerName: ['集团客户经理', '集团客户经理名称', '集团客户经理姓名'],
  productId: ['产品大类ID', '产品大类id', '产品大类Id'],
  productName: ['产品大类名称', '产品大类', '产品名称'],
  category: ['政企分类产品'],
  gross: ['出账金额'], tax: ['税费'], adjustment: ['调账金额'],
  adjustmentTax: ['调账税费'], revenue: ['计算后信息化收入']
};
const text = (value) => String(value ?? '').trim();
const header = (value) => text(value).replace(/\s/g, '');

function sourceMonth(value) {
  const candidate = text(value);
  if (/^\d{6}$/.test(candidate)) return validMonth(`${candidate.slice(0, 4)}-${candidate.slice(4)}`);
  const match = /^(\d{4})[年/-](\d{1,2})月?$/.exec(candidate);
  return validMonth(match ? `${match[1]}-${match[2].padStart(2, '0')}` : candidate);
}

export function fileHash(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

export function parseRevenueWorkbook(buffer, tolerance = 1) {
  let workbook;
  try { workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellFormula: true }); }
  catch { fail('无法读取 Excel 文件，请检查文件是否损坏或加密'); }
  const candidates = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    if (range.e.r > 200000 || range.e.c > 255) fail('报表范围过大，最多支持 200000 行、256 列');
    const cells = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true });
    const headers = (cells[0] || []).map(header);
    if (fields.month.some((name) => headers.includes(name))) candidates.push({ sheetName, sheet, cells, headers, range });
  }
  if (candidates.length !== 1) fail(candidates.length ? '存在多个收入工作表，请每次上传一个收入工作表' : 'Excel 缺少必要字段：月份（不能从文件名推断）');
  const { sheetName, sheet, cells, headers, range } = candidates[0];
  const indexes = {};
  for (const [field, aliases] of Object.entries(fields)) {
    const matches = headers.flatMap((name, index) => aliases.includes(name) ? [index] : []);
    if (!matches.length) fail(`Excel 缺少必要字段：${aliases[0]}`);
    if (matches.length > 1) fail(`Excel 字段重复或别名冲突：${aliases[0]}`);
    indexes[field] = matches[0];
  }
  const warnings = ['金额单位待确认，当前按原表金额单位展示；原始报表收入不会被税率推算覆盖。'];
  let blankAmounts = 0;
  let unclassified = 0;
  let mismatches = 0;
  let taxMismatches = 0;
  const unknownTaxes = new Set();
  const rows = [];
  const owners = new Map();
  for (let index = 1; index < cells.length; index++) {
    const values = cells[index];
    if (values.every((value) => text(value) === '')) continue;
    const rowNumber = range.s.r + index + 1;
    const row = { rowNumber, sheetName };
    for (const [field, column] of Object.entries(indexes)) {
      const value = values[column];
      if (['gross', 'tax', 'adjustment', 'adjustmentTax', 'revenue'].includes(field)) {
        const cell = sheet[XLSX.utils.encode_cell({ r: rowNumber - 1, c: range.s.c + column })];
        if (cell?.t === 'e' || (cell?.f && (cell.v === undefined || cell.v === ''))) fail(`第 ${rowNumber} 行金额公式无有效缓存，请在 Excel 重新计算后保存`);
        if (text(value) === '') blankAmounts++;
        row[field] = toCents(value, `第 ${rowNumber} 行${fields[field][0]}`, field !== 'revenue');
      } else if (field === 'month') {
        try { row.month = sourceMonth(value); } catch { fail(`第 ${rowNumber} 行月份无效，请使用 YYYY-MM 或 YYYYMM`); }
      } else {
        // Preserve formatted text identifiers, including Excel's zero-padding formats.
        const cell = sheet[XLSX.utils.encode_cell({ r: rowNumber - 1, c: range.s.c + column })];
        row[field] = text(['groupCode', 'managerId', 'productId'].includes(field) && cell?.t === 'n' ? XLSX.utils.format_cell(cell) : value);
      }
    }
    row.raw = Object.fromEntries(headers.map((name, column) => [name || `列${column + 1}`, values[column] ?? '']));
    row.rawCells = values;
    if (!row.category) { row.category = '未分类'; unclassified++; }
    if (row.groupCode) {
      const key = JSON.stringify([row.month, row.groupCode]);
      if (owners.has(key) && owners.get(key) !== row.managerId) fail(`第 ${rowNumber} 行：同月同集团存在多个客户经理ID，请核验归属`);
      owners.set(key, row.managerId);
    }
    if (Math.abs(addCents(row.gross, -row.tax, row.adjustment, -row.adjustmentTax, -row.revenue)) > tolerance) mismatches++;
    const rate = productTaxRate(row.productName);
    if (rate === null) unknownTaxes.add('空产品名称');
    else if (Math.abs(addCents(row.gross, -netCents(row.gross, rate), -row.tax)) > tolerance
      || Math.abs(addCents(row.adjustment, -netCents(row.adjustment, rate), -row.adjustmentTax)) > tolerance) taxMismatches++;
    rows.push(row);
  }
  if (!rows.length) fail('报表没有有效收入明细');
  if (blankAmounts) warnings.push(`${blankAmounts} 个空金额字段按零保存（正式收入不允许为空）`);
  if (unclassified) warnings.push(`${unclassified} 行分类为空，已展示为未分类并保留收入`);
  if (mismatches) warnings.push(`${mismatches} 行收入与出账、税费及调账计算不一致，保留原表收入，请核验`);
  if (taxMismatches) warnings.push(`${taxMismatches} 行实际税费与明确产品税率推算不一致，保留原值，请核验`);
  if (unknownTaxes.size) warnings.push('存在空产品名称，税率待核验；专线卫士及延伸服务为 6%，其他非空产品为 9%');
  const months = [...new Set(rows.map((row) => row.month))].sort();
  if (months.length > 1) warnings.push(`文件包含 ${months.length} 个收入月份，将在同一事务中按月提交`);
  return { sheetName, rows, months, warnings };
}

export function importTotals(rows) {
  let total = 0, line = 0, ungrouped = 0;
  const groups = new Set();
  for (const row of rows) {
    if (!row.groupCode) { ungrouped = addCents(ungrouped, row.revenue); continue; }
    groups.add(row.groupCode);
    total = addCents(total, row.revenue);
    if (row.category === '专线') line = addCents(line, row.revenue);
  }
  return { rowCount: rows.length, groupCount: groups.size, totalRevenue: money(total), lineRevenue: money(line), ungroupedRevenue: money(ungrouped) };
}

export function monthHash(rows) {
  // Order-independent multiset: identical no-group rows remain repeated, never deduplicated.
  return fileHash(JSON.stringify(rows.map(({ rowNumber, sheetName, rawCells, raw, ...row }) => ({
    ...row, raw: Object.fromEntries(Object.entries(raw).sort(([a], [b]) => a.localeCompare(b)))
  })).map((row) => JSON.stringify(row)).sort()));
}
