import { filtersToSearchParams } from '../utils.js';

// List request: current page plus every filter, the sort and the KPI scope.
export function ledgerListQuery(filters, { page, pageSize, sort, kpiMode }) {
  return filtersToSearchParams(filters, {
    page,
    pageSize,
    sortBy: sort.key,
    sortDirection: sort.direction,
    kpiMode: kpiMode ? '1' : '0'
  }).toString();
}

// Export request: the same filters, sort and KPI scope, but never a page, so the
// export always covers every matching row rather than the visible page.
export function ledgerExportQuery(filters, { sort, kpiMode }) {
  return filtersToSearchParams(filters, {
    sortBy: sort.key,
    sortDirection: sort.direction,
    kpiMode: kpiMode ? '1' : '0'
  }).toString();
}

export function countActiveFilters(filters, keys) {
  return keys.filter((key) => Boolean(filters[key])).length;
}

// Clicking a statistic replaces the filters with that statistic, scoped to the chosen
// month; clicking the total clears every filter.
export function filtersForStat(emptyFilters, statFilter, month) {
  if (!statFilter) return emptyFilters;
  return { ...emptyFilters, statFilter, statMonth: month };
}

// When the statistics month changes, a month-scoped statistic follows it; other filters do not change.
export function followStatMonth(filters, month) {
  if (!filters.statFilter || !filters.statFilter.includes('InMonth')) return filters;
  return { ...filters, statMonth: month };
}
