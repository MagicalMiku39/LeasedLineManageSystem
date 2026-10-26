import { useEffect, useMemo, useRef, useState } from 'react';
import { isAbort, requestJson } from '../api.js';
import { emptyFilters, ledgerPageSize } from './config.js';
import { filtersForStat, followStatMonth, ledgerExportQuery, ledgerListQuery } from './query.js';
import { toggleKey } from './columnSettings.js';

const emptyOptions = { regions: [], products: [], statuses: [], managers: [], ledgerStatuses: [] };

// Loads `path` when it or `revision` changes and drops answers to requests that have
// since been replaced, so a slow earlier search can never overwrite a newer one.
function useApiResource({ enabled, path, onUnauthorized }) {
  const [state, setState] = useState({ data: null, loading: false, error: '' });
  const [revision, setRevision] = useState(0);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));
    requestJson(path, { signal: controller.signal })
      .then((data) => setState({ data, loading: false, error: '' }))
      .catch((error) => {
        if (isAbort(error)) return;
        if (error.status === 401) unauthorized.current?.();
        // Keep what is on screen; the error explains why it may be out of date.
        setState((current) => ({ ...current, loading: false, error: error.message }));
      });
    return () => controller.abort();
  }, [enabled, path, revision]);

  return { ...state, reload: () => setRevision((value) => value + 1) };
}

// Filters, sort, paging and the current page of ledger rows. Filters and the page survive
// switching to other menus because this state lives above the views.
export function useLedger({ enabled, kpiMode, month, onUnauthorized }) {
  const [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'updated_at', direction: 'desc' });
  const [selectedIds, setSelectedIds] = useState([]);

  const query = useMemo(
    () => ledgerListQuery(filters, { page, pageSize: ledgerPageSize, sort, kpiMode }),
    [filters, page, sort, kpiMode]
  );
  const exportQuery = useMemo(() => ledgerExportQuery(filters, { sort, kpiMode }), [filters, sort, kpiMode]);
  const resource = useApiResource({ enabled, path: `/ledger?${query}`, onUnauthorized });
  const rows = resource.data?.rows || [];
  const total = resource.data?.total || 0;

  // A new result set clears the row selection, as before.
  useEffect(() => setSelectedIds([]), [resource.data]);

  // A month-scoped statistic follows the statistics month.
  useEffect(() => {
    setFilters((current) => followStatMonth(current, month));
  }, [month]);

  return {
    filters,
    rows,
    total,
    loading: resource.loading,
    error: resource.error,
    loaded: resource.data !== null,
    page,
    setPage,
    totalPages: Math.max(1, Math.ceil(total / ledgerPageSize)),
    sort,
    selectedIds,
    exportQuery,
    reload: resource.reload,
    updateFilter(key, value) {
      setPage(1);
      setFilters((current) => ({ ...current, [key]: value }));
    },
    clearFilters() {
      setPage(1);
      setFilters(emptyFilters);
    },
    applyStat(statFilter) {
      setPage(1);
      setFilters(filtersForStat(emptyFilters, statFilter, month));
    },
    toggleSort(key) {
      setPage(1);
      setSort((current) => ({
        key,
        direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc'
      }));
    },
    toggleRow: (id) => setSelectedIds((current) => toggleKey(current, id)),
    toggleAllRows: (checked) => setSelectedIds(checked ? rows.map((row) => row.id) : []),
    // Switching the KPI scope returns to the first page and drops the row selection.
    resetForScopeChange() {
      setPage(1);
      setSelectedIds([]);
    }
  };
}

export function useLedgerStats({ enabled, month, kpiMode, onUnauthorized }) {
  const params = new URLSearchParams({ month, kpiMode: kpiMode ? '1' : '0' });
  const resource = useApiResource({ enabled, path: `/stats?${params.toString()}`, onUnauthorized });
  return { stats: resource.data, loading: resource.loading, error: resource.error, reload: resource.reload };
}

export function useLedgerOptions({ enabled, onUnauthorized }) {
  const resource = useApiResource({ enabled, path: '/options', onUnauthorized });
  return { options: resource.data || emptyOptions, error: resource.error, reload: resource.reload };
}
