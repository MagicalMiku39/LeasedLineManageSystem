import { Router } from 'express';
import { ensureGroupDirectory } from './groups.js';

// Default annual target (net additions: added minus cancelled lines) until one is set for the year.
export const annualNetTarget = 230;
// A forecast is either lines expected to open or lines expected to be cancelled.
export const forecastKinds = ['added', 'cancelled'];
// How sure a forecast is, most sure first. The page names each level for its kind (已签约 for an
// addition, 已提交销户 for a cancellation); nothing is weighted, the levels are only added up apart.
export const confidenceLevels = ['certain', 'likely', 'possible', 'watch', 'unrated'];
const confidenceWords = {
  added: { certain: '已签约', likely: '已下单施工中', possible: '在谈', watch: '意向', unrated: '未评估' },
  cancelled: { certain: '已提交销户', likely: '基本确定', possible: '有销户风险', watch: '观察中', unrated: '未评估' }
};
const confidenceNames = (kind) => confidenceWords[kind] || confidenceWords.added;
const monthName = (year, month) => `${year}年${month}月`;

// Today in Beijing: the month decides which forecast months are open and which are overdue.
function beijingToday(date = new Date()) {
  const [year, month, day] = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date).split('-').map(Number);
  const dayOfYear = (Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86400000 + 1;
  const daysInYear = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  return { year, month, day, dayOfYear, daysInYear };
}

// Forecasts can be entered from this month to the end of the year, and for any month of next
// year, which is kept apart as next year's reserve and never counts toward this year.
export function openForecastMonths(today = beijingToday()) {
  const months = [];
  for (let month = today.month; month <= 12; month += 1) months.push({ year: today.year, month });
  for (let month = 1; month <= 12; month += 1) months.push({ year: today.year + 1, month });
  return months;
}

const groupMatchLimit = 20;
const maxProgressNote = 500;

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

/**
 * KPI achievement: this year's net additions so far (same periods, status sets and KPI scope as
 * the ledger's year totals), per manager, plus hand-entered forecasts of lines still to open or
 * to be cancelled. A forecast marked as landed stays on record but no longer counts, since the
 * real line is then already in the actual numbers.
 */
export function createKpiRouter({ db, leasedLineSource, currentUser, currentPeriod, addedStatuses, cancelledStatuses, productTypes, today = beijingToday }) {
  const router = Router();
  db.exec(`CREATE TABLE IF NOT EXISTS kpi_forecast (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    group_code TEXT NOT NULL,
    group_name TEXT NOT NULL,
    manager_name TEXT NOT NULL,
    product_type TEXT NOT NULL,
    line_count INTEGER NOT NULL CHECK(line_count > 0),
    landed INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  // Tables created before forecasts of cancellations existed hold additions only.
  const forecastColumns = db.prepare('PRAGMA table_info(kpi_forecast)').all().map((column) => column.name);
  if (!forecastColumns.includes('kind')) {
    db.exec("ALTER TABLE kpi_forecast ADD COLUMN kind TEXT NOT NULL DEFAULT 'added'");
  }
  // Tables from before partial progress: a forecast marked as landed had landed in full.
  if (!forecastColumns.includes('landed_count')) {
    db.exec(`ALTER TABLE kpi_forecast ADD COLUMN landed_count INTEGER NOT NULL DEFAULT 0;
      UPDATE kpi_forecast SET landed_count = line_count WHERE landed = 1;`);
  }
  // Forecasts from before confidence levels wait for someone to rate them.
  if (!forecastColumns.includes('confidence')) {
    db.exec("ALTER TABLE kpi_forecast ADD COLUMN confidence TEXT NOT NULL DEFAULT 'unrated'");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS kpi_forecast_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    forecast_id INTEGER NOT NULL REFERENCES kpi_forecast(id) ON DELETE CASCADE,
    note TEXT NOT NULL,
    landed_count INTEGER,
    created_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kpi_forecast_progress_forecast ON kpi_forecast_progress(forecast_id, id);
  CREATE TABLE IF NOT EXISTS kpi_forecast_match (
    forecast_id INTEGER NOT NULL REFERENCES kpi_forecast(id) ON DELETE CASCADE,
    line_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('confirmed', 'dismissed')),
    decided_by TEXT,
    decided_at TEXT NOT NULL,
    PRIMARY KEY (forecast_id, line_id)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS kpi_target (
    year INTEGER PRIMARY KEY,
    net_target INTEGER NOT NULL CHECK(net_target > 0),
    updated_by TEXT,
    updated_at TEXT NOT NULL
  )`);

  function targetFor(year) {
    return db.prepare('SELECT net_target FROM kpi_target WHERE year = ?').get(year)?.net_target ?? annualNetTarget;
  }

  ensureGroupDirectory(db);

  // A group with no lines yet, as the full group list has it.
  function directoryGroup(groupCode) {
    return db.prepare("SELECT group_code, COALESCE(group_name, '') AS group_name, COALESCE(manager_name, '') AS manager_name FROM group_directory WHERE group_code = ?").get(groupCode) || null;
  }

  // The group's name and manager as the ledger has them; with several, the one on most lines.
  function ledgerGroup(groupCode) {
    return db.prepare(
      `SELECT group_code, COALESCE(group_name, '') AS group_name, COALESCE(manager_name, '') AS manager_name,
              COUNT(*) AS line_count, MAX(updated_at) AS latest
       FROM leased_line
       WHERE group_code = ?
       GROUP BY group_name, manager_name
       ORDER BY line_count DESC, latest DESC
       LIMIT 1`
    ).get(groupCode) || null;
  }

  const forecastSelect = `SELECT f.id, f.year, f.month, f.kind, f.group_code, f.group_name, f.manager_name, f.product_type,
      f.line_count, f.landed_count, f.confidence, f.created_at, f.updated_at,
      (SELECT note FROM kpi_forecast_progress p WHERE p.forecast_id = f.id ORDER BY p.id DESC LIMIT 1) AS latest_note,
      (SELECT created_at FROM kpi_forecast_progress p WHERE p.forecast_id = f.id ORDER BY p.id DESC LIMIT 1) AS latest_at
    FROM kpi_forecast f`;

  // Only the part not yet in the ledger still counts as a forecast. One whose month has passed
  // with part of it still to land is overdue; it keeps counting until it lands or is moved.
  function withRemaining(row) {
    const remaining = Math.max(row.line_count - row.landed_count, 0);
    const now = today();
    const overdue = remaining > 0 && (row.year < now.year || (row.year === now.year && row.month < now.month));
    return { ...row, remaining, landed: remaining === 0, overdue };
  }

  function isOpenMonth(year, month) {
    return openForecastMonths(today()).some((item) => item.year === year && item.month === month);
  }

  function forecastRows(year) {
    return db.prepare(`${forecastSelect} WHERE f.year = ? ORDER BY f.month ASC, f.kind ASC, f.id ASC`).all(year).map(withRemaining);
  }

  function forecastRow(id) {
    const row = db.prepare(`${forecastSelect} WHERE f.id = ?`).get(id);
    return row ? withRemaining(row) : null;
  }

  function saveProgress(id, { note, landedCount, lineCount, username, alsoInTransaction }) {
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE kpi_forecast SET line_count = ?, landed_count = ?, landed = ?, updated_at = ? WHERE id = ?')
        .run(lineCount, landedCount, landedCount >= lineCount ? 1 : 0, now, id);
      if (note) {
        db.prepare('INSERT INTO kpi_forecast_progress (forecast_id, note, landed_count, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, note, landedCount, username, now);
      }
      alsoInTransaction?.(now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Lines a later import brought in (or cancelled) in the forecast's group: likely what it
   * predicted. Only ever a suggestion for a person to confirm. A line counts once: one confirmed
   * elsewhere is not offered again, and one dismissed here is not offered here again. Outside the
   * KPI products a line would not move the KPI, so it is not offered either.
   */
  function suggestionsFor(forecast) {
    if (forecast.remaining <= 0) return [];
    const statuses = forecast.kind === 'cancelled' ? cancelledStatuses : addedStatuses;
    return db.prepare(
      `SELECT l.id AS line_id, l.group_product_code, l.product_name, l.start_time, l.status_time, l.manager_name,
              COALESCE(l.product_status_name, l.ledger_status, '') AS status, MIN(c.created_at) AS imported_at
       FROM ledger_change c
       JOIN leased_line l ON l.id = c.line_id
       WHERE c.change_type = ? AND c.created_at >= ? AND l.group_code = ?
         AND l.product_name IN (${placeholders(productTypes)})
         AND COALESCE(l.product_status_name, l.ledger_status, '') IN (${placeholders(statuses)})
         AND NOT EXISTS (SELECT 1 FROM kpi_forecast_match m WHERE m.line_id = l.id AND m.status = 'confirmed')
         AND NOT EXISTS (SELECT 1 FROM kpi_forecast_match m WHERE m.line_id = l.id AND m.forecast_id = ?)
       GROUP BY l.id
       ORDER BY imported_at ASC, l.id ASC`
    ).all(forecast.kind, forecast.created_at, forecast.group_code, ...productTypes, ...statuses, forecast.id)
      .map((line) => ({ ...line, sameProduct: line.product_name === forecast.product_type }));
  }

  /** Forecasts with something to look at, for the notice after an import. */
  router.countSuggestions = () => forecastRows(currentPeriod().year)
    .reduce((sum, forecast) => sum + Math.min(suggestionsFor(forecast).length, forecast.remaining), 0);

  /** The KPI page's figures; the workbench shows the same ones. */
  router.overview = (query) => {
    const period = currentPeriod();
    const source = leasedLineSource(query);
    const statusName = "COALESCE(product_status_name, ledger_status, '')";
    const range = [period.yearStart, period.nextYearStart];

    const managers = db.prepare(
      `SELECT COALESCE(NULLIF(manager_name, ''), '未填写') AS manager_name,
              SUM(CASE WHEN start_time >= ? AND start_time < ? AND ${statusName} IN (${placeholders(addedStatuses)}) THEN 1 ELSE 0 END) AS added,
              SUM(CASE WHEN status_time >= ? AND status_time < ? AND ${statusName} IN (${placeholders(cancelledStatuses)}) THEN 1 ELSE 0 END) AS cancelled
       FROM ${source}
       GROUP BY COALESCE(NULLIF(manager_name, ''), '未填写')`
    ).all(...range, ...addedStatuses, ...range, ...cancelledStatuses)
      .filter((row) => row.added > 0 || row.cancelled > 0)
      .map((row) => ({ ...row, net: row.added - row.cancelled }));

    const added = managers.reduce((sum, row) => sum + row.added, 0);
    const cancelled = managers.reduce((sum, row) => sum + row.cancelled, 0);
    const forecasts = forecastRows(period.year).map((row) => ({ ...row, suggestions: suggestionsFor(row).length }));
    const reserve = forecastRows(period.year + 1).map((row) => ({ ...row, suggestions: suggestionsFor(row).length }));
    const pending = forecasts.filter((row) => !row.landed);
    const total = (rows) => rows.reduce((sum, row) => sum + row.remaining, 0);
    const split = (rows) => ({
      added: total(rows.filter((row) => row.kind === 'added')),
      cancelled: total(rows.filter((row) => row.kind === 'cancelled'))
    });
    const byMonth = Object.fromEntries([...new Set(pending.map((row) => row.month))].sort((a, b) => a - b)
      .map((month) => [month, split(pending.filter((row) => row.month === month))]));
    const byConfidence = Object.fromEntries(confidenceLevels
      .map((level) => [level, split(pending.filter((row) => (row.confidence || 'unrated') === level))]));
    const overdue = pending.filter((row) => row.overdue);
    const forecastAdded = total(pending.filter((row) => row.kind === 'added'));
    const forecastCancelled = total(pending.filter((row) => row.kind === 'cancelled'));
    const actualNet = added - cancelled;

    // The same lines by month of their start / status time, for the year's trend.
    const perMonth = (column, statuses) => Object.fromEntries(db.prepare(
      `SELECT CAST(substr(${column}, 6, 2) AS INTEGER) AS month, COUNT(*) AS count
       FROM ${source}
       WHERE ${column} >= ? AND ${column} < ? AND ${statusName} IN (${placeholders(statuses)})
       GROUP BY month`
    ).all(...range, ...statuses).map((row) => [row.month, row.count]));
    const addedByMonth = perMonth('start_time', addedStatuses);
    const cancelledByMonth = perMonth('status_time', cancelledStatuses);
    const monthly = Array.from({ length: 12 }, (_, index) => ({
      month: index + 1,
      added: addedByMonth[index + 1] ?? 0,
      cancelled: cancelledByMonth[index + 1] ?? 0
    }));

    // How much of the year has gone by, against how much of the target is done.
    const now = today();
    const target = targetFor(period.year);
    const elapsed = now.year === period.year ? now.dayOfYear / now.daysInYear : null;

    return {
      year: period.year,
      lastImportAt: db.prepare("SELECT MAX(imported_at) AS at FROM import_batch WHERE status = 'finished'").get().at ?? null,
      target,
      defaultTarget: annualNetTarget,
      currentMonth: now.year === period.year ? now.month : null,
      months: openForecastMonths(now),
      confidenceLevels,
      productTypes,
      actual: { added, cancelled, net: actualNet },
      monthly,
      pace: elapsed === null ? null : { elapsed, dayOfYear: now.dayOfYear, daysInYear: now.daysInYear, expected: Math.round(target * elapsed) },
      forecast: {
        added: forecastAdded,
        cancelled: forecastCancelled,
        net: forecastAdded - forecastCancelled,
        byMonth,
        byConfidence,
        overdue: { forecasts: overdue.length, ...split(overdue) },
        expectedNet: actualNet + forecastAdded - forecastCancelled
      },
      managers,
      forecasts,
      reserve
    };
  };

  router.get('/', (req, res) => {
    res.json(router.overview(req.query));
  });

  // The current year's target, editable on the page.
  router.put('/target', (req, res) => {
    const target = Number(req.body?.target);
    if (!Number.isSafeInteger(target) || target <= 0) return res.status(400).json({ error: '年度目标须为正整数' });
    const year = currentPeriod().year;
    db.prepare(`INSERT INTO kpi_target (year, net_target, updated_by, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(year) DO UPDATE SET net_target = excluded.net_target, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(year, target, currentUser(req)?.username || '', new Date().toISOString());
    res.json({ year, target });
  });

  // Group lookup for the forecast form: code or name, one row per group code. Groups with lines
  // come from the ledger; the full group list adds the ones that have none yet.
  router.get('/groups', (req, res) => {
    const keyword = String(req.query.q || '').trim();
    if (!keyword) return res.json([]);
    const rows = db.prepare(
      `SELECT group_code, COALESCE(group_name, '') AS group_name, COALESCE(manager_name, '') AS manager_name,
              COUNT(*) AS line_count, MAX(updated_at) AS latest
       FROM leased_line
       WHERE group_code IS NOT NULL AND group_code <> '' AND (group_code LIKE ? OR group_name LIKE ?)
       GROUP BY group_code, group_name, manager_name
       ORDER BY CASE WHEN group_code LIKE ? THEN 0 ELSE 1 END, group_code ASC, line_count DESC, latest DESC
       LIMIT 400`
    ).all(`%${keyword}%`, `%${keyword}%`, `${keyword}%`);
    const groups = [];
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.group_code)) continue;
      seen.add(row.group_code);
      groups.push({ group_code: row.group_code, group_name: row.group_name, manager_name: row.manager_name, source: 'ledger' });
      if (groups.length >= groupMatchLimit) break;
    }
    const listed = db.prepare(
      `SELECT group_code, COALESCE(group_name, '') AS group_name, COALESCE(manager_name, '') AS manager_name
       FROM group_directory
       WHERE (group_code LIKE ? OR group_name LIKE ?) AND group_code NOT IN (SELECT group_code FROM leased_line WHERE group_code IS NOT NULL)
       ORDER BY CASE WHEN group_code = ? THEN 0 WHEN group_code LIKE ? THEN 1 ELSE 2 END, group_code ASC
       LIMIT ?`
    ).all(`%${keyword}%`, `%${keyword}%`, keyword, `${keyword}%`, groupMatchLimit);
    for (const row of listed) groups.push({ ...row, source: 'directory' });
    res.json(groups);
  });

  router.post('/forecasts', (req, res) => {
    const body = req.body || {};
    const groupCode = String(body.group_code ?? '').trim();
    const productType = String(body.product_type ?? '').trim();
    const kind = body.kind ?? 'added';
    const year = body.year === undefined ? currentPeriod().year : Number(body.year);
    const month = Number(body.month);
    const lineCount = Number(body.line_count);
    const confidence = body.confidence ?? 'unrated';
    if (!forecastKinds.includes(kind)) return res.status(400).json({ error: '预计类别只能是新增或销户' });
    if (!groupCode) return res.status(400).json({ error: '请填写集团编码' });
    if (!productTypes.includes(productType)) return res.status(400).json({ error: '请选择产品类型' });
    if (!isOpenMonth(year, month)) return res.status(400).json({ error: '预计月份只能选本月到明年年底' });
    if (!Number.isSafeInteger(lineCount) || lineCount <= 0) return res.status(400).json({ error: '预计条数须为正整数' });
    if (!confidenceLevels.includes(confidence)) return res.status(400).json({ error: '把握度不正确' });

    // A group in the ledger keeps the ledger's name and manager; one only on the full group list
    // keeps the list's; any other group is entered by hand.
    const known = ledgerGroup(groupCode) || directoryGroup(groupCode);
    const groupName = known ? known.group_name : String(body.group_name ?? '').trim();
    const managerName = known ? known.manager_name : String(body.manager_name ?? '').trim();
    if (!groupName) return res.status(400).json({ error: '台账和全量集团清单中都没有该集团，请填写集团名称' });
    if (!managerName) return res.status(400).json({ error: '台账和全量集团清单中都没有该集团，请填写客户经理' });

    const now = new Date().toISOString();
    const result = db.prepare(
      `INSERT INTO kpi_forecast (year, month, kind, group_code, group_name, manager_name, product_type, line_count, landed, confidence, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    ).run(year, month, kind, groupCode, groupName, managerName, productType, lineCount, confidence, currentUser(req)?.username || '', now, now);
    res.status(201).json(db.prepare('SELECT * FROM kpi_forecast WHERE id = ?').get(Number(result.lastInsertRowid)));
  });

  router.patch('/forecasts/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '预计记录不正确' });
    const existing = db.prepare('SELECT * FROM kpi_forecast WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '预计记录不存在' });
    const body = req.body || {};
    let lineCount = existing.line_count;
    let landedCount = existing.landed_count;
    let note = '';
    let restoring = false;
    // Rating a forecast or moving its month leaves a line in its progress, like any other change.
    const notes = [];
    let confidence = existing.confidence || 'unrated';
    let year = existing.year;
    let month = existing.month;
    if (Object.hasOwn(body, 'confidence')) {
      if (!confidenceLevels.includes(body.confidence)) return res.status(400).json({ error: '把握度不正确' });
      if (body.confidence !== confidence) notes.push(`把握度：${confidenceNames(existing.kind)[confidence]} → ${confidenceNames(existing.kind)[body.confidence]}`);
      confidence = body.confidence;
    }
    if (Object.hasOwn(body, 'month')) {
      const nextYear = body.year === undefined ? existing.year : Number(body.year);
      const nextMonth = Number(body.month);
      if (nextYear !== existing.year || nextMonth !== existing.month) {
        if (!isOpenMonth(nextYear, nextMonth)) return res.status(400).json({ error: '预计月份只能选本月到明年年底' });
        notes.push(`预计月份：${monthName(existing.year, existing.month)} → ${monthName(nextYear, nextMonth)}`);
        year = nextYear;
        month = nextMonth;
      }
    }
    if (Object.hasOwn(body, 'line_count')) {
      lineCount = Number(body.line_count);
      if (!Number.isSafeInteger(lineCount) || lineCount <= 0) return res.status(400).json({ error: '预计条数须为正整数' });
      if (lineCount < landedCount) return res.status(400).json({ error: `已落地 ${landedCount} 条，预计条数不能更少` });
    }
    // The one-click shortcut: everything landed, or back to all forecast. It leaves a trace too.
    if (Object.hasOwn(body, 'landed')) {
      if (typeof body.landed !== 'boolean') return res.status(400).json({ error: '落地状态不正确' });
      landedCount = body.landed ? lineCount : 0;
      restoring = !body.landed;
      const doneWord = existing.kind === 'cancelled' ? '全部销户' : '全部落地';
      if (landedCount !== existing.landed_count) note = body.landed ? `标记为${doneWord}` : '恢复为预计';
    }
    saveProgress(id, {
      note: [...notes, note].filter(Boolean).join('；'),
      landedCount,
      lineCount,
      username: currentUser(req)?.username || '',
      // Back to all forecast: lines confirmed for it are free to be suggested again.
      alsoInTransaction: () => {
        db.prepare('UPDATE kpi_forecast SET confidence = ?, year = ?, month = ? WHERE id = ?').run(confidence, year, month, id);
        if (restoring) db.prepare("DELETE FROM kpi_forecast_match WHERE forecast_id = ? AND status = 'confirmed'").run(id);
      }
    });
    res.json(forecastRow(id));
  });

  router.get('/forecasts/:id/progress', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '预计记录不正确' });
    const forecast = forecastRow(id);
    if (!forecast) return res.status(404).json({ error: '预计记录不存在' });
    const entries = db.prepare(
      'SELECT id, note, landed_count, created_by, created_at FROM kpi_forecast_progress WHERE forecast_id = ? ORDER BY id DESC'
    ).all(id);
    res.json({ forecast, entries, suggestions: suggestionsFor(forecast) });
  });

  // A person's answer to one suggestion. Only what is currently on offer can be answered.
  router.post('/forecasts/:id/matches', (req, res) => {
    const id = Number(req.params.id);
    const lineId = Number(req.body?.line_id);
    const action = req.body?.action;
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(lineId) || lineId <= 0) return res.status(400).json({ error: '记录不正确' });
    if (!['confirm', 'dismiss'].includes(action)) return res.status(400).json({ error: '操作不正确' });
    const forecast = forecastRow(id);
    if (!forecast) return res.status(404).json({ error: '预计记录不存在' });
    const line = suggestionsFor(forecast).find((item) => item.line_id === lineId);
    if (!line) return res.status(409).json({ error: '这条建议已经不存在，请刷新后再看' });
    const username = currentUser(req)?.username || '';
    const saveMatch = (status, at) => db.prepare(
      'INSERT INTO kpi_forecast_match (forecast_id, line_id, status, decided_by, decided_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, lineId, status, username, at);
    if (action === 'dismiss') {
      saveMatch('dismissed', new Date().toISOString());
    } else {
      const word = forecast.kind === 'cancelled' ? '销户' : '落地';
      saveProgress(id, {
        note: `确认${word} 1 条：${line.group_product_code}（${line.product_name}）`,
        landedCount: forecast.landed_count + 1,
        lineCount: forecast.line_count,
        username,
        alsoInTransaction: (at) => saveMatch('confirmed', at)
      });
    }
    res.json({ forecast: forecastRow(id), suggestions: suggestionsFor(forecastRow(id)) });
  });

  // The time is the server's own, so a phone with a wrong clock cannot misdate an update.
  router.post('/forecasts/:id/progress', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '预计记录不正确' });
    const existing = db.prepare('SELECT * FROM kpi_forecast WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '预计记录不存在' });
    const note = String(req.body?.note ?? '').trim();
    if (!note) return res.status(400).json({ error: '请填写进展说明' });
    if (note.length > maxProgressNote) return res.status(400).json({ error: `进展说明不能超过 ${maxProgressNote} 字` });
    let landedCount = existing.landed_count;
    const given = req.body?.landed_count;
    if (given !== undefined && given !== null && given !== '') {
      landedCount = Number(given);
      if (!Number.isSafeInteger(landedCount) || landedCount < 0 || landedCount > existing.line_count) {
        return res.status(400).json({ error: `已落地条数须为 0–${existing.line_count} 的整数` });
      }
    }
    saveProgress(id, { note, landedCount, lineCount: existing.line_count, username: currentUser(req)?.username || '' });
    res.status(201).json(forecastRow(id));
  });

  router.delete('/forecasts/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '预计记录不正确' });
    const result = db.prepare('DELETE FROM kpi_forecast WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: '预计记录不存在' });
    res.json({ id });
  });

  return router;
}
