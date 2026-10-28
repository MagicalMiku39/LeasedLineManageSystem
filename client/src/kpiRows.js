import { defaultManagers } from './ledger/config.js';

// Per-manager rows for the chosen scope. The 18 managers always show, with 0 when they have no
// lines this year; "all" lists every manager with an addition, a cancellation or a forecast.
// Landed forecasts no longer count: their lines are already in the actual numbers.
export function kpiManagerRows(managers, forecasts, scope) {
  const actual = new Map(managers.map((row) => [row.manager_name, row]));
  const forecast = new Map();
  for (const row of forecasts) {
    if (row.landed) continue;
    const current = forecast.get(row.manager_name) || { added: 0, cancelled: 0 };
    current[row.kind === 'cancelled' ? 'cancelled' : 'added'] += row.line_count;
    forecast.set(row.manager_name, current);
  }
  const names = scope === 'defaults'
    ? defaultManagers
    : [...new Set([...actual.keys(), ...forecast.keys()])];
  return names.map((name) => {
    const row = actual.get(name);
    const added = row?.added || 0;
    const cancelled = row?.cancelled || 0;
    const expected = forecast.get(name) || { added: 0, cancelled: 0 };
    return {
      manager_name: name,
      added,
      cancelled,
      net: added - cancelled,
      forecastAdded: expected.added,
      forecastCancelled: expected.cancelled,
      expectedNet: added - cancelled + expected.added - expected.cancelled
    };
  }).sort((left, right) => right.net - left.net || right.expectedNet - left.expectedNet || left.manager_name.localeCompare(right.manager_name, 'zh-CN'));
}
