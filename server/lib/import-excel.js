import XLSX from 'xlsx';
import { db, makeBatchId, nowIso } from './db.js';
import { excelFieldMap, excelHeaders } from './field-map.js';

const dbColumns = Object.values(excelFieldMap);

function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
  const text = String(value).trim();
  return text === '' ? null : text;
}

function normalizeAmount(value) {
  const normalized = normalizeValue(value);
  if (normalized === null) return null;
  const number = Number(String(normalized).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function rowToRecord(row) {
  const record = {};
  for (const [header, column] of Object.entries(excelFieldMap)) {
    record[column] = normalizeValue(row[header]);
  }
  record.total_arrears = normalizeAmount(row['总欠费']);
  record.package_fee = normalizeAmount(row['活动套餐资费']);
  record.ledger_status = record.product_status_name || null;
  return record;
}

function validateHeaders(headers) {
  const missing = excelHeaders.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    throw new Error(`Excel 缺少必要字段：${missing.join('、')}`);
  }
}

function createInsertStatement() {
  const columns = [...dbColumns, 'ledger_status', 'import_batch_id', 'created_at', 'updated_at'];
  const placeholders = columns.map(() => '?').join(', ');
  return {
    columns,
    statement: db.prepare(`INSERT INTO leased_line (${columns.join(', ')}) VALUES (${placeholders})`)
  };
}

function createUpdateStatement() {
  const columns = [...dbColumns, 'ledger_status', 'import_batch_id', 'updated_at'];
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  return {
    columns,
    statement: db.prepare(`UPDATE leased_line SET ${assignments} WHERE id = ?`)
  };
}

export function importExcel(filePath, fileName) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  validateHeaders(headers);

  const batchId = makeBatchId();
  const startedAt = nowIso();
  let successRows = 0;
  let failedRows = 0;
  let updatedRows = 0;

  db.prepare(
    `INSERT INTO import_batch
      (id, file_name, sheet_name, total_rows, imported_at, status, message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(batchId, fileName, sheetName, rows.length, startedAt, 'running', '导入中');

  const findExisting = db.prepare(
    `SELECT id FROM leased_line WHERE group_product_code = ? AND group_product_code IS NOT NULL AND group_product_code <> ''`
  );
  const insert = createInsertStatement();
  const update = createUpdateStatement();
  const log = db.prepare(
    `INSERT INTO import_row_log (batch_id, row_number, result, message, related_line_id)
     VALUES (?, ?, ?, ?, ?)`
  );

  db.exec('BEGIN');
  try {
    rows.forEach((row, index) => {
      const excelRowNumber = index + 2;
      try {
        const record = rowToRecord(row);
        const existing = record.group_product_code ? findExisting.get(record.group_product_code) : null;
        const timestamp = nowIso();

        if (existing) {
          const values = update.columns.map((column) => {
            if (column === 'import_batch_id') return batchId;
            if (column === 'updated_at') return timestamp;
            return record[column] ?? null;
          });
          update.statement.run(...values, existing.id);
          updatedRows += 1;
          log.run(batchId, excelRowNumber, 'updated', '已更新已有记录', existing.id);
        } else {
          const values = insert.columns.map((column) => {
            if (column === 'import_batch_id') return batchId;
            if (column === 'created_at' || column === 'updated_at') return timestamp;
            return record[column] ?? null;
          });
          const result = insert.statement.run(...values);
          successRows += 1;
          log.run(batchId, excelRowNumber, 'success', '已新增记录', Number(result.lastInsertRowid));
        }
      } catch (error) {
        failedRows += 1;
        log.run(batchId, excelRowNumber, 'failed', error.message, null);
      }
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.prepare('UPDATE import_batch SET status = ?, message = ? WHERE id = ?').run('failed', error.message, batchId);
    throw error;
  }

  db.prepare(
    `UPDATE import_batch
     SET success_rows = ?, failed_rows = ?, updated_rows = ?, status = ?, message = ?
     WHERE id = ?`
  ).run(successRows, failedRows, updatedRows, 'finished', '导入完成', batchId);

  return {
    batchId,
    sheetName,
    totalRows: rows.length,
    successRows,
    failedRows,
    updatedRows
  };
}
