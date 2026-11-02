import { db } from './db.js';
import {
  addedStatuses,
  cancelledStatuses,
  kpiProductSqlList,
  stoppedStatus,
  stoppingStatus
} from './ledger-rules.js';

const defaultPageSize = 100;
const maxPageSize = 500;

db.exec(`
CREATE TABLE IF NOT EXISTS ledger_change (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  line_id INTEGER,
  group_product_code TEXT,
  group_name TEXT,
  manager_name TEXT,
  change_type TEXT NOT NULL,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_change_batch ON ledger_change(batch_id, change_type, id);
CREATE INDEX IF NOT EXISTS idx_ledger_change_line ON ledger_change(line_id, id);

CREATE TABLE IF NOT EXISTS ledger_import_summary (
  batch_id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  net_before INTEGER,
  net_after INTEGER,
  baseline INTEGER NOT NULL DEFAULT 0
);
`);

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

function statusChangeType(next) {
  if (cancelledStatuses.includes(next)) return 'cancelled';
  if (next === stoppedStatus || next === stoppingStatus) return 'stopped';
  return 'status';
}

/**
 * What differs between a stored line and the row just imported. Overdue amounts are left out on
 * purpose: they move every month for many lines and would bury the changes people look for.
 * A blank package fee in the file keeps the stored fee, as the import itself does.
 */
export function diffLine(existing, record) {
  const changes = [];
  const compare = (type, field, next = record[field], note = '') => {
    if (text(existing[field]) !== text(next)) {
      changes.push({ type, field, oldValue: existing[field] ?? null, newValue: next ?? null, note });
    }
  };

  const statusChanged = text(existing.product_status_name) !== text(record.product_status_name);
  if (statusChanged) {
    compare(statusChangeType(record.product_status_name), 'product_status_name', record.product_status_name, record.status_time ? `状态时间 ${record.status_time}` : '');
  }
  compare('manager', 'manager_name');
  compare('manager', 'manager_job_no');
  const nextFee = record.package_fee ?? existing.package_fee ?? null;
  if (Number(existing.package_fee ?? NaN) !== Number(nextFee ?? NaN) && !(existing.package_fee == null && nextFee == null)) {
    changes.push({ type: 'fee', field: 'package_fee', oldValue: existing.package_fee ?? null, newValue: nextFee, note: '' });
  }
  compare('product', 'product_name');
  compare('group', 'group_code');
  compare('group', 'group_name');
  compare('time', 'start_time');
  // With a status change the new time is part of that change, not news of its own.
  if (!statusChanged) compare('time', 'status_time');
  return changes;
}

const insertStatement = () => db.prepare(
  `INSERT INTO ledger_change
    (batch_id, line_id, group_product_code, group_name, manager_name, change_type, field_name, old_value, new_value, note, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

/** Returns a function that records one change of the given batch for one line. */
export function changeRecorder(batchId, timestamp) {
  const insert = insertStatement();
  return (line, change) => insert.run(
    batchId,
    line.id ?? null,
    line.group_product_code ?? null,
    line.group_name ?? null,
    line.manager_name ?? null,
    change.type,
    change.field ?? null,
    change.oldValue === null || change.oldValue === undefined ? null : String(change.oldValue),
    change.newValue === null || change.newValue === undefined ? null : String(change.newValue),
    change.note || null,
    timestamp
  );
}

export function beijingYear(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(date));
}

/** The year's KPI net additions, by the same rules as the ledger's and KPI page's totals. */
export function computeYearNet(database, year) {
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;
  const status = "COALESCE(product_status_name, ledger_status, '')";
  const count = (column, statuses) => database.prepare(
    `SELECT COUNT(*) AS count FROM leased_line
     WHERE product_name IN (${kpiProductSqlList}) AND ${column} >= ? AND ${column} < ?
       AND ${status} IN (${statuses.map(() => '?').join(', ')})`
  ).get(start, end, ...statuses).count;
  return count('start_time', addedStatuses) - count('status_time', cancelledStatuses);
}

export function previousFinishedBatchId(currentBatchId = '') {
  return db.prepare(
    "SELECT id FROM import_batch WHERE status = 'finished' AND id <> ? ORDER BY imported_at DESC LIMIT 1"
  ).get(currentBatchId)?.id ?? null;
}

export function saveImportSummary({ batchId, year, netBefore, netAfter, baseline }) {
  db.prepare(
    `INSERT INTO ledger_import_summary (batch_id, year, net_before, net_after, baseline) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(batch_id) DO UPDATE SET year = excluded.year, net_before = excluded.net_before, net_after = excluded.net_after, baseline = excluded.baseline`
  ).run(batchId, year, netBefore, netAfter, baseline ? 1 : 0);
}

/** Counts per change type and the year's net before and after; null when nothing was recorded. */
export function importChangeSummary(batchId) {
  const row = db.prepare('SELECT year, net_before, net_after, baseline FROM ledger_import_summary WHERE batch_id = ?').get(batchId);
  if (!row) return null;
  const counts = {};
  for (const item of db.prepare('SELECT change_type, COUNT(DISTINCT COALESCE(line_id, id)) AS count FROM ledger_change WHERE batch_id = ? GROUP BY change_type').all(batchId)) {
    counts[item.change_type] = item.count;
  }
  return { year: row.year, netBefore: row.net_before, netAfter: row.net_after, baseline: row.baseline === 1, counts };
}

export function listBatchChanges(batchId, { type, before, limit } = {}) {
  const size = Math.min(Math.max(Number(limit) || defaultPageSize, 1), maxPageSize);
  const where = ['batch_id = ?'];
  const params = [batchId];
  if (type) {
    where.push('change_type = ?');
    params.push(String(type));
  }
  if (Number.isSafeInteger(Number(before)) && Number(before) > 0) {
    where.push('id > ?');
    params.push(Number(before));
  }
  const rows = db.prepare(
    `SELECT id, line_id, group_product_code, group_name, manager_name, change_type, field_name, old_value, new_value, note
     FROM ledger_change WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`
  ).all(...params, size + 1);
  return { summary: importChangeSummary(batchId), rows: rows.slice(0, size), hasMore: rows.length > size };
}

export function listLineChanges(lineId) {
  return db.prepare(
    `SELECT id, batch_id, change_type, field_name, old_value, new_value, note, created_at
     FROM ledger_change WHERE line_id = ? ORDER BY id DESC LIMIT 200`
  ).all(lineId);
}

export function lastImportAt() {
  return db.prepare("SELECT MAX(imported_at) AS at FROM import_batch WHERE status = 'finished'").get().at ?? null;
}
