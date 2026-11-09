import { defaultManagers } from './ledger/config.js';

// Per-manager rows for the chosen scope. The 18 managers always show, with 0 when they have no
// lines this year; "all" lists every manager with an addition, a cancellation or a forecast.
// Only the part of a forecast not yet landed counts: the rest is already in the actual numbers.
export function kpiManagerRows(managers, forecasts, scope) {
  const actual = new Map(managers.map((row) => [row.manager_name, row]));
  const forecast = new Map();
  for (const row of forecasts) {
    if (row.remaining <= 0) continue;
    const current = forecast.get(row.manager_name) || { added: 0, cancelled: 0 };
    current[row.kind === 'cancelled' ? 'cancelled' : 'added'] += row.remaining;
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

/** A forecast's state in words, by how much of it has landed. */
export function forecastState(row) {
  const done = row.kind === 'cancelled' ? '已销户' : '已落地';
  if (row.landed_count <= 0) return '预计';
  if (row.remaining <= 0) return done;
  return `部分${row.kind === 'cancelled' ? '销户' : '落地'}`;
}

// How sure a forecast is, most sure first, named for its kind. The server keeps the same levels.
export const confidenceOrder = ['certain', 'likely', 'possible', 'watch', 'unrated'];
const confidenceWords = {
  added: { certain: '已签约', likely: '已下单施工中', possible: '在谈', watch: '意向', unrated: '未评估' },
  cancelled: { certain: '已提交销户', likely: '基本确定', possible: '有销户风险', watch: '观察中', unrated: '未评估' }
};

export function confidenceName(kind, level) {
  return (confidenceWords[kind] || confidenceWords.added)[level || 'unrated'];
}

/**
 * The gap to the target, closed step by step: what is done, then each confidence level's
 * forecasts (new minus cancelled) from the surest down. Each step says what the year would come
 * to and how far from the target that still is.
 */
export function gapSteps(actualNet, target, byConfidence) {
  let running = actualNet;
  return confidenceOrder.map((level) => {
    const added = byConfidence?.[level]?.added || 0;
    const cancelled = byConfidence?.[level]?.cancelled || 0;
    running += added - cancelled;
    return { level, added, cancelled, net: added - cancelled, expected: running, gap: target - running };
  });
}
