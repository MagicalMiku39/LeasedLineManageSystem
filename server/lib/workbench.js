import { Router } from 'express';
import { importChangeSummary } from './ledger-changes.js';
import { stoppedDays, warningLevel } from './warnings.js';

function beijingParts(date = new Date()) {
  const text = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return { day: text, month: Number(text.slice(5, 7)) };
}

/**
 * 工作台: what the latest ledger import changed and what is left to act on, in one answer. It
 * adds no figures of its own: the KPI numbers are the KPI page's, the warnings are the warning
 * page's lines nobody has marked yet, and the strategic changes come from that import's change
 * record. Everything follows the KPI switch like the pages it points to.
 */
export function createWorkbenchRouter({ db, leasedLineSource, kpi, strategic, repairName = (name) => name, now = () => new Date() }) {
  const router = Router();

  function warnings(query) {
    const asOf = beijingParts(now()).day;
    const byLevel = { cancel: 0, red: 0, yellow: 0, green: 0 };
    const rows = db.prepare(
      `SELECT l.status_time FROM ${leasedLineSource(query)} l
       LEFT JOIN line_warning_mark m ON m.line_id = l.id
       WHERE l.product_status_name = '停机' AND l.total_arrears > 0 AND m.line_id IS NULL`
    ).all();
    for (const row of rows) {
      const days = stoppedDays(row.status_time, asOf);
      if (days !== null) byLevel[warningLevel(days)] += 1;
    }
    return { asOf, unmarked: Object.values(byLevel).reduce((sum, value) => sum + value, 0), byLevel };
  }

  function kpiProgress(query) {
    const overview = kpi.overview(query);
    const monthsLeft = 12 - beijingParts(now()).month + 1;
    const gap = overview.target - overview.actual.net;
    return {
      year: overview.year,
      target: overview.target,
      actual: overview.actual,
      forecast: { added: overview.forecast.added, cancelled: overview.forecast.cancelled, expectedNet: overview.forecast.expectedNet },
      gap,
      monthsLeft,
      perMonth: gap > 0 ? Math.ceil(gap / monthsLeft) : 0,
      gapAfterForecast: overview.target - overview.forecast.expectedNet,
      suggestions: kpi.countSuggestions()
    };
  }

  router.get('/', (req, res) => {
    const latest = db.prepare(
      "SELECT id, file_name, imported_at, success_rows, updated_rows, failed_rows FROM import_batch WHERE status = 'finished' ORDER BY imported_at DESC LIMIT 1"
    ).get() ?? null;
    res.json({
      latestImport: latest && {
        id: latest.id,
        fileName: repairName(latest.file_name),
        importedAt: latest.imported_at,
        addedRows: latest.success_rows,
        updatedRows: latest.updated_rows,
        failedRows: latest.failed_rows,
        changes: importChangeSummary(latest.id)
      },
      kpi: kpiProgress(req.query),
      warnings: warnings(req.query),
      strategic: strategic.importChanges(latest?.id ?? '', req.query)
    });
  });

  return router;
}
