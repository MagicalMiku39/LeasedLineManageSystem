import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fail, money, netCents, toCents, validMonth } from './revenue-money.js';
import { fileHash, importTotals, monthHash, parseRevenueWorkbook } from './revenue-import.js';
import { createRevenueQueries } from './revenue-report.js';

export const revenueSchema = `
CREATE TABLE IF NOT EXISTS revenue_batch (
  id TEXT PRIMARY KEY, file_name TEXT NOT NULL, file_hash TEXT NOT NULL,
  archive_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'preview',
  warnings_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, committed_at TEXT
);
CREATE INDEX IF NOT EXISTS revenue_batch_hash ON revenue_batch(file_hash);
CREATE TABLE IF NOT EXISTS revenue_batch_month (
  batch_id TEXT NOT NULL REFERENCES revenue_batch(id), month TEXT NOT NULL,
  fingerprint TEXT NOT NULL, baseline_batch TEXT, active INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(batch_id, month)
);
CREATE UNIQUE INDEX IF NOT EXISTS revenue_one_active_month ON revenue_batch_month(month) WHERE active = 1;
CREATE TABLE IF NOT EXISTS revenue_source_row (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL REFERENCES revenue_batch(id),
  month TEXT NOT NULL, group_code TEXT NOT NULL, row_number INTEGER NOT NULL, data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revenue_rows_batch ON revenue_source_row(batch_id, month, group_code);
CREATE TABLE IF NOT EXISTS revenue_service (
  id TEXT PRIMARY KEY, group_code TEXT NOT NULL, month TEXT NOT NULL,
  data_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revenue_services_group ON revenue_service(group_code, month);
CREATE TABLE IF NOT EXISTS revenue_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  action TEXT NOT NULL, before_json TEXT, after_json TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revenue_settings (id INTEGER PRIMARY KEY CHECK(id = 1), tolerance_cents INTEGER NOT NULL);
INSERT OR IGNORE INTO revenue_settings(id, tolerance_cents) VALUES(1, 1);
`;

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function cleanText(value, label, max = 200, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label}格式无效`);
  return value.trim();
}

function fileName(value) {
  let name = String(value || '收入报表.xlsx');
  if (/^[\u0000-\u00ff]+$/.test(name)) {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!decoded.includes('\ufffd')) name = decoded;
  }
  return basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f]/g, '').slice(0, 240);
}

export function serviceView(row) {
  const data = JSON.parse(row.data_json);
  return { ...data, id: row.id, version: row.version, grossAmount: money(data.grossCents), revenue: money(data.netCents),
    taxRate: 0.06, createdBy: row.created_by, updatedBy: row.updated_by,
    createdAt: row.created_at, updatedAt: row.updated_at, deleted: Boolean(row.deleted) };
}

export function createRevenueStore({ db, uploadDir, leasedLineSource }) {
  db.exec(revenueSchema);
  const archiveDir = join(uploadDir, 'revenue');
  mkdirSync(archiveDir, { recursive: true });
  const active = (month) => db.prepare('SELECT batch_id FROM revenue_batch_month WHERE month = ? AND active = 1').get(month)?.batch_id ?? null;
  const allRows = (batch, month) => db.prepare('SELECT data_json FROM revenue_source_row WHERE batch_id = ? AND month = ? ORDER BY row_number').all(batch, month).map((row) => JSON.parse(row.data_json));
  const audit = (type, id, action, before, after, actor) => db.prepare(`INSERT INTO revenue_audit
    (entity_type, entity_id, action, before_json, after_json, actor, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)`).run(
    type, id, action, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), actor, new Date().toISOString());
  const queries = createRevenueQueries({ db, leasedLineSource });

  function settings(payload, actor) {
    const current = { tolerance: money(db.prepare('SELECT tolerance_cents FROM revenue_settings WHERE id = 1').get().tolerance_cents) };
    if (payload === undefined) return current;
    const tolerance = toCents(payload?.tolerance, '舍入容差');
    if (tolerance < 0) fail('舍入容差不能为负数');
    return transaction(db, () => {
      db.prepare('UPDATE revenue_settings SET tolerance_cents = ? WHERE id = 1').run(tolerance);
      const next = { tolerance: money(tolerance) };
      audit('settings', '1', 'update', current, next, actor);
      return next;
    });
  }

  function preview(buffer, originalName, actor) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 32 * 1024 * 1024) fail('文件无效或超过 32MB 限制');
    const parsed = parseRevenueWorkbook(buffer, toCents(settings().tolerance));
    const hash = fileHash(buffer);
    const id = randomUUID();
    const name = fileName(originalName);
    const archiveName = `${id}.xlsx`;
    const archivePath = join(archiveDir, archiveName);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(archivePath, buffer, { flag: 'wx' });
    try {
      return transaction(db, () => {
        const duplicateFile = Boolean(db.prepare("SELECT 1 FROM revenue_batch WHERE file_hash = ? AND status = 'committed'").get(hash));
        const monthData = parsed.months.map((month) => {
          const rows = parsed.rows.filter((row) => row.month === month);
          const baseline = active(month);
          const fingerprint = monthHash(rows);
          const prior = baseline ? importTotals(allRows(baseline, month)) : null;
          const duplicate = Boolean(baseline && db.prepare('SELECT 1 FROM revenue_batch_month WHERE batch_id = ? AND month = ? AND fingerprint = ?').get(baseline, month, fingerprint));
          return { month, rows, baseline, fingerprint, duplicate, totals: { month, ...importTotals(rows), previousRevenue: prior?.totalRevenue ?? null, previousRowCount: prior?.rowCount ?? null } };
        });
        const duplicate = duplicateFile || monthData.every((item) => item.duplicate);
        const warnings = [...parsed.warnings];
        if (duplicate) warnings.push('此文件或全部月份明细已导入，不能重复提交');
        if (monthData.some((item) => item.baseline && !item.duplicate)) warnings.push('包含已导入月份：提交将替换有效批次，并使该月服务确认失效，需重新核验');
        db.prepare(`INSERT INTO revenue_batch(id, file_name, file_hash, archive_name, warnings_json, created_by, created_at, expires_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(id, name, hash, archiveName, JSON.stringify(warnings), actor, createdAt, expiresAt);
        const monthInsert = db.prepare('INSERT INTO revenue_batch_month(batch_id, month, fingerprint, baseline_batch) VALUES(?, ?, ?, ?)');
        const rowInsert = db.prepare('INSERT INTO revenue_source_row(batch_id, month, group_code, row_number, data_json) VALUES(?, ?, ?, ?, ?)');
        for (const item of monthData) monthInsert.run(id, item.month, item.fingerprint, item.baseline);
        for (const row of parsed.rows) rowInsert.run(id, row.month, row.groupCode, row.rowNumber, JSON.stringify(row));
        audit('batch', id, 'preview', null, { fileName: name, months: parsed.months, fileHash: hash }, actor);
        return { id, fileName: name, months: monthData.map((item) => item.totals), warnings, duplicate };
      });
    } catch (error) { unlinkSync(archivePath); throw error; }
  }

  function commit(id, payload, actor) {
    if (payload?.replace !== true) fail('请明确确认替换：replace 必须为 true');
    return transaction(db, () => {
      const batch = db.prepare('SELECT * FROM revenue_batch WHERE id = ?').get(id);
      if (!batch || batch.status !== 'preview') fail('预览不存在或已提交，请重新预览');
      if (batch.created_by !== actor) fail('只能提交本人创建的预览');
      if (batch.expires_at <= new Date().toISOString()) fail('预览已过期，请重新上传预览');
      let archived;
      try { archived = readFileSync(join(archiveDir, batch.archive_name)); } catch { fail('原始报表已缺失，请重新上传预览'); }
      if (fileHash(archived) !== batch.file_hash) fail('原始报表已变化，请重新上传预览');
      if (db.prepare("SELECT 1 FROM revenue_batch WHERE file_hash = ? AND status = 'committed'").get(batch.file_hash)) fail('相同文件已经导入，不能重复提交');
      const months = db.prepare('SELECT * FROM revenue_batch_month WHERE batch_id = ? ORDER BY month').all(id);
      for (const item of months) if (active(item.month) !== item.baseline_batch) fail('预览已失效：该月份有效批次发生变化，请重新预览');
      let invalidatedServices = 0;
      const changedMonths = [], skippedMonths = [];
      for (const item of months) {
        const baseline = item.baseline_batch;
        if (baseline && db.prepare('SELECT 1 FROM revenue_batch_month WHERE batch_id = ? AND month = ? AND fingerprint = ?').get(baseline, item.month, item.fingerprint)) {
          skippedMonths.push(item.month); continue;
        }
        db.prepare('UPDATE revenue_batch_month SET active = 0 WHERE month = ? AND active = 1').run(item.month);
        db.prepare('UPDATE revenue_batch_month SET active = 1 WHERE batch_id = ? AND month = ?').run(id, item.month);
        // Reconfirmation is a deliberate user save, never an automatic carry-over to a revision.
        const services = db.prepare('SELECT * FROM revenue_service WHERE month = ? AND deleted = 0').all(item.month);
        for (const row of services) {
          const before = serviceView(row);
          const data = JSON.parse(row.data_json);
          data.confirmed = false;
          data.needsReview = true;
          db.prepare('UPDATE revenue_service SET data_json = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(data), actor, new Date().toISOString(), row.id);
          audit('service', row.id, 'import-invalidate', before, serviceView(db.prepare('SELECT * FROM revenue_service WHERE id = ?').get(row.id)), actor);
          invalidatedServices++;
        }
        changedMonths.push(item.month);
      }
      if (!changedMonths.length) fail('所有月份明细已导入，不能重复提交');
      db.prepare("UPDATE revenue_batch SET status = 'committed', committed_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      const result = { id, fileName: batch.file_name, months: changedMonths, skippedMonths, invalidatedServices, status: 'committed' };
      audit('batch', id, 'commit', months.map((item) => ({ month: item.month, batchId: item.baseline_batch })), result, actor);
      return result;
    });
  }

  function saveService(id, payload, actor) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('服务登记内容无效');
    const groupCode = cleanText(payload.groupCode, '集团编码');
    const month = validMonth(payload.month);
    const name = cleanText(payload.name, '服务名称');
    const grossCents = toCents(payload.grossAmount, '含税出账金额');
    const coverage = payload.coverage;
    const frequency = payload.frequency;
    if (!['included', 'excluded', 'pending'].includes(coverage)) fail('报表覆盖状态无效');
    if (typeof payload.confirmed !== 'boolean') fail('confirmed 必须为布尔值');
    if (coverage === 'pending' && payload.confirmed) fail('待核验覆盖状态不能确认实际收入');
    if (!['once', 'monthly'].includes(frequency)) fail('服务频次必须为 once 或 monthly');
    const endMonth = payload.endMonth == null || payload.endMonth === '' ? null : validMonth(payload.endMonth);
    if (endMonth && (frequency !== 'monthly' || endMonth < month)) fail('有效截止月份应不早于起始月，且仅适用于按月服务');
    const remark = payload.remark == null ? '' : cleanText(payload.remark, '备注', 4000, false);
    const sourceRowId = payload.sourceRowId == null || payload.sourceRowId === '' ? null : payload.sourceRowId;
    if (!id && (typeof payload.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.requestId))) fail('缺少有效的请求标识，请重新打开登记表单');
    if (id && !Number.isSafeInteger(payload.version)) fail('缺少记录版本，请刷新后重试');
    if (sourceRowId !== null && (!Number.isSafeInteger(sourceRowId) || sourceRowId <= 0)) fail('来源行ID必须为正整数');
    if (coverage === 'excluded' && sourceRowId !== null) fail('报表未包含的服务不能绑定报表来源行，请重新核验覆盖状态');
    return transaction(db, () => {
      const before = id ? db.prepare('SELECT * FROM revenue_service WHERE id = ? AND deleted = 0').get(id) : null;
      if (id && !before) fail('服务不存在或已删除');
      if (before && payload.version !== undefined && payload.version !== before.version) fail('服务已被修改，请刷新后重试');
      const batch = active(month);
      if (!batch) fail('该月份尚无有效报表，请先导入');
      if (!db.prepare('SELECT 1 FROM revenue_source_row WHERE batch_id = ? AND month = ? AND group_code = ?').get(batch, month, groupCode)) fail('该集团在所选月份无报表记录，请核验集团编码');
      if (sourceRowId !== null && !db.prepare('SELECT 1 FROM revenue_source_row WHERE id = ? AND batch_id = ? AND month = ? AND group_code = ?').get(sourceRowId, batch, month, groupCode)) fail('来源行不属于该集团的当月有效报表，请重新选择');
      if (sourceRowId !== null) {
        const existing = db.prepare('SELECT id, data_json FROM revenue_service WHERE month = ? AND group_code = ? AND deleted = 0').all(month, groupCode);
        if (existing.some((row) => row.id !== (id || payload.requestId) && JSON.parse(row.data_json).sourceRowId === sourceRowId)) fail('该报表来源行已关联服务，请修改已有记录');
      }
      const serviceId = id || payload.requestId;
      const timestamp = new Date().toISOString();
      const data = { groupCode, month, name, grossCents, netCents: netCents(grossCents, 6), coverage,
        confirmed: payload.confirmed, frequency, endMonth, sourceRowId, remark,
        needsReview: false, confirmedBatchId: payload.confirmed ? batch : null };
      if (!id) {
        const replay = db.prepare('SELECT * FROM revenue_service WHERE id = ?').get(serviceId);
        if (replay) {
          if (replay.deleted || replay.version !== 1 || replay.created_by !== actor || replay.data_json !== JSON.stringify(data)) fail('登记请求已经处理或内容发生变化，请刷新后核验');
          return serviceView(replay);
        }
      }
      if (before) db.prepare('UPDATE revenue_service SET group_code = ?, month = ?, data_json = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?')
        .run(groupCode, month, JSON.stringify(data), actor, timestamp, serviceId);
      else db.prepare('INSERT INTO revenue_service(id, group_code, month, data_json, created_by, created_at, updated_by, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
        .run(serviceId, groupCode, month, JSON.stringify(data), actor, timestamp, actor, timestamp);
      const result = serviceView(db.prepare('SELECT * FROM revenue_service WHERE id = ?').get(serviceId));
      audit('service', serviceId, before ? 'update' : 'create', before ? serviceView(before) : null, result, actor);
      return result;
    });
  }

  function deleteService(id, actor, version) {
    if (!Number.isSafeInteger(version)) fail('缺少记录版本，请刷新后重试');
    return transaction(db, () => {
      const row = db.prepare('SELECT * FROM revenue_service WHERE id = ? AND deleted = 0').get(id);
      if (!row) fail('服务不存在或已删除');
      if (version !== undefined && version !== row.version) fail('服务已被修改，请刷新后重试');
      db.prepare('UPDATE revenue_service SET deleted = 1, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(actor, new Date().toISOString(), id);
      audit('service', id, 'delete', serviceView(row), serviceView(db.prepare('SELECT * FROM revenue_service WHERE id = ?').get(id)), actor);
      return { id, deleted: true };
    });
  }

  return { ...queries, preview, commit, saveService, deleteService, settings };
}
