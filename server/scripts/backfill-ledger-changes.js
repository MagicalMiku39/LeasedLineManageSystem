// Rebuilds the change record of one past import from the two report files it sits between:
//
//   node server/scripts/backfill-ledger-changes.js <earlier file> <later file> [--batch <id>] [--apply]
//
// Without --apply it only prints what it would record. The ledger itself is never changed. It
// refuses unless the later file really is that import: same row count, same number of new lines.
import { DatabaseSync } from 'node:sqlite';
import { db } from '../lib/db.js';
import { rowToRecord } from '../lib/import-excel.js';
import { changeRecorder, computeYearNet, diffLine, saveImportSummary } from '../lib/ledger-changes.js';
import XLSX from '../lib/xlsx.js';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readRecords(file) {
  const workbook = XLSX.readFile(file, { cellDates: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '', raw: false });
  return rows.map(rowToRecord).filter((record) => record.group_product_code);
}

function yearNetOf(records, year) {
  const memory = new DatabaseSync(':memory:');
  memory.exec(`CREATE TABLE leased_line (product_name TEXT, start_time TEXT, status_time TEXT, product_status_name TEXT, ledger_status TEXT)`);
  const insert = memory.prepare('INSERT INTO leased_line VALUES (?, ?, ?, ?, ?)');
  for (const record of records) {
    insert.run(record.product_name, record.start_time, record.status_time, record.product_status_name, record.ledger_status);
  }
  const net = computeYearNet(memory, year);
  memory.close();
  return net;
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const batchFlag = args.indexOf('--batch');
const batchId = batchFlag >= 0 ? args[batchFlag + 1] : null;
const [earlierFile, laterFile] = args.filter((arg, index) => !arg.startsWith('--') && (batchFlag < 0 || index !== batchFlag + 1));
if (!earlierFile || !laterFile) fail('用法：backfill-ledger-changes.js <较早的文件> <较新的文件> [--batch <批次号>] [--apply]');

const batch = batchId
  ? db.prepare('SELECT * FROM import_batch WHERE id = ?').get(batchId)
  : db.prepare("SELECT * FROM import_batch WHERE status = 'finished' ORDER BY imported_at DESC LIMIT 1").get();
if (!batch) fail('没有找到这次导入');
if (db.prepare('SELECT 1 FROM ledger_import_summary WHERE batch_id = ?').get(batch.id)) fail('这次导入已经有变更记录，不会重复生成');

const earlier = readRecords(earlierFile);
const later = readRecords(laterFile);
const previous = new Map(earlier.map((record) => [record.group_product_code, record]));
const current = new Set(later.map((record) => record.group_product_code));
const added = later.filter((record) => !previous.has(record.group_product_code));
if (later.length !== batch.total_rows) fail(`较新的文件有 ${later.length} 行，这次导入是 ${batch.total_rows} 行，不是同一份文件`);
if (added.length !== batch.success_rows) fail(`按文件算新增 ${added.length} 条，这次导入记录的是 ${batch.success_rows} 条，文件对不上`);

const year = Number(String(batch.imported_at).slice(0, 4));
const netBefore = yearNetOf(earlier, year);
const netAfter = yearNetOf(later, year);
const findLine = db.prepare('SELECT id FROM leased_line WHERE group_product_code = ?');
const planned = [];
for (const record of later) {
  const before = previous.get(record.group_product_code);
  if (!before) planned.push([record, { type: 'added', note: record.product_status_name ? `状态 ${record.product_status_name}` : '' }]);
  else for (const change of diffLine(before, record)) planned.push([{ ...before, ...record }, change]);
}
for (const record of earlier) {
  if (!current.has(record.group_product_code)) {
    planned.push([record, { type: 'missing', note: `这次的报表里没有这条，台账仍保留原状态${record.product_status_name ? ` ${record.product_status_name}` : ''}` }]);
  }
}

const counts = {};
for (const [, change] of planned) counts[change.type] = (counts[change.type] || 0) + 1;
console.log(`批次 ${batch.id}，导入时间 ${batch.imported_at}`);
console.log(`较早 ${earlier.length} 行，较新 ${later.length} 行，变更 ${planned.length} 条：${JSON.stringify(counts)}`);
console.log(`${year} 年 KPI 净增 ${netBefore} → ${netAfter}`);
if (!apply) {
  console.log('这是预览，什么都没有写入。确认后加 --apply。');
  process.exit(0);
}

const record = changeRecorder(batch.id, batch.imported_at);
db.exec('BEGIN');
try {
  for (const [line, change] of planned) {
    record({ ...line, id: findLine.get(line.group_product_code)?.id ?? null }, change);
  }
  saveImportSummary({ batchId: batch.id, year, netBefore, netAfter, baseline: false });
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
console.log('已写入。');
