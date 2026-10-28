import { Router } from 'express';

// Default annual target (net additions: added minus cancelled lines) until one is set for the year.
export const annualNetTarget = 230;
// Forecasts cover the rest of the year only.
export const forecastMonths = [11, 12];
// A forecast is either lines expected to open or lines expected to be cancelled.
export const forecastKinds = ['added', 'cancelled'];

const groupMatchLimit = 20;

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

/**
 * KPI achievement: this year's net additions so far (same periods, status sets and KPI scope as
 * the ledger's year totals), per manager, plus hand-entered forecasts of lines still to open or
 * to be cancelled. A forecast marked as landed stays on record but no longer counts, since the
 * real line is then already in the actual numbers.
 */
export function createKpiRouter({ db, leasedLineSource, currentUser, currentPeriod, addedStatuses, cancelledStatuses, productTypes }) {
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
  db.exec(`CREATE TABLE IF NOT EXISTS kpi_target (
    year INTEGER PRIMARY KEY,
    net_target INTEGER NOT NULL CHECK(net_target > 0),
    updated_by TEXT,
    updated_at TEXT NOT NULL
  )`);

  function targetFor(year) {
    return db.prepare('SELECT net_target FROM kpi_target WHERE year = ?').get(year)?.net_target ?? annualNetTarget;
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

  function forecastRows(year) {
    return db.prepare(
      `SELECT id, year, month, kind, group_code, group_name, manager_name, product_type, line_count, landed, created_at, updated_at
       FROM kpi_forecast WHERE year = ? ORDER BY month ASC, kind ASC, id ASC`
    ).all(year).map((row) => ({ ...row, landed: row.landed === 1 }));
  }

  router.get('/', (req, res) => {
    const period = currentPeriod();
    const source = leasedLineSource(req.query);
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
    const forecasts = forecastRows(period.year);
    const pending = forecasts.filter((row) => !row.landed);
    const total = (rows) => rows.reduce((sum, row) => sum + row.line_count, 0);
    const byMonth = Object.fromEntries(forecastMonths.map((month) => {
      const inMonth = pending.filter((row) => row.month === month);
      return [month, {
        added: total(inMonth.filter((row) => row.kind === 'added')),
        cancelled: total(inMonth.filter((row) => row.kind === 'cancelled'))
      }];
    }));
    const forecastAdded = total(pending.filter((row) => row.kind === 'added'));
    const forecastCancelled = total(pending.filter((row) => row.kind === 'cancelled'));
    const actualNet = added - cancelled;

    res.json({
      year: period.year,
      target: targetFor(period.year),
      defaultTarget: annualNetTarget,
      months: forecastMonths,
      productTypes,
      actual: { added, cancelled, net: actualNet },
      forecast: {
        added: forecastAdded,
        cancelled: forecastCancelled,
        net: forecastAdded - forecastCancelled,
        byMonth,
        expectedNet: actualNet + forecastAdded - forecastCancelled
      },
      managers,
      forecasts
    });
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

  // Group lookup for the forecast form: code or name, one row per group code.
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
      groups.push({ group_code: row.group_code, group_name: row.group_name, manager_name: row.manager_name });
      if (groups.length >= groupMatchLimit) break;
    }
    res.json(groups);
  });

  router.post('/forecasts', (req, res) => {
    const body = req.body || {};
    const groupCode = String(body.group_code ?? '').trim();
    const productType = String(body.product_type ?? '').trim();
    const kind = body.kind ?? 'added';
    const month = Number(body.month);
    const lineCount = Number(body.line_count);
    if (!forecastKinds.includes(kind)) return res.status(400).json({ error: '预计类别只能是新增或销户' });
    if (!groupCode) return res.status(400).json({ error: '请填写集团编码' });
    if (!productTypes.includes(productType)) return res.status(400).json({ error: '请选择产品类型' });
    if (!forecastMonths.includes(month)) return res.status(400).json({ error: '预计月份只能选择 11 月或 12 月' });
    if (!Number.isSafeInteger(lineCount) || lineCount <= 0) return res.status(400).json({ error: '预计条数须为正整数' });

    // A group already in the ledger keeps its own name and manager; a new group is entered by hand.
    const known = ledgerGroup(groupCode);
    const groupName = known ? known.group_name : String(body.group_name ?? '').trim();
    const managerName = known ? known.manager_name : String(body.manager_name ?? '').trim();
    if (!groupName) return res.status(400).json({ error: '台账中没有该集团，请填写集团名称' });
    if (!managerName) return res.status(400).json({ error: '台账中没有该集团，请填写客户经理' });

    const now = new Date().toISOString();
    const result = db.prepare(
      `INSERT INTO kpi_forecast (year, month, kind, group_code, group_name, manager_name, product_type, line_count, landed, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(currentPeriod().year, month, kind, groupCode, groupName, managerName, productType, lineCount, currentUser(req)?.username || '', now, now);
    res.status(201).json(db.prepare('SELECT * FROM kpi_forecast WHERE id = ?').get(Number(result.lastInsertRowid)));
  });

  router.patch('/forecasts/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '预计记录不正确' });
    const existing = db.prepare('SELECT * FROM kpi_forecast WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '预计记录不存在' });
    const body = req.body || {};
    let lineCount = existing.line_count;
    let landed = existing.landed;
    if (Object.hasOwn(body, 'line_count')) {
      lineCount = Number(body.line_count);
      if (!Number.isSafeInteger(lineCount) || lineCount <= 0) return res.status(400).json({ error: '预计条数须为正整数' });
    }
    if (Object.hasOwn(body, 'landed')) {
      if (typeof body.landed !== 'boolean') return res.status(400).json({ error: '落地状态不正确' });
      landed = body.landed ? 1 : 0;
    }
    db.prepare('UPDATE kpi_forecast SET line_count = ?, landed = ?, updated_at = ? WHERE id = ?')
      .run(lineCount, landed, new Date().toISOString(), id);
    res.json(db.prepare('SELECT * FROM kpi_forecast WHERE id = ?').get(id));
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
