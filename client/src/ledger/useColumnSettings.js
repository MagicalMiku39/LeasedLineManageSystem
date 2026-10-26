import { useEffect, useMemo, useState } from 'react';
import { columnOrderStorageKey, defaultVisibleColumns, tableColumns, visibleColumnsStorageKey } from './config.js';
import {
  moveColumn,
  normalizeColumnOrder,
  normalizeVisibleColumns,
  readStoredJson,
  toggleKey,
  writeStoredJson
} from './columnSettings.js';

const columnKeys = tableColumns.map((column) => column.key);
const columnsByKey = new Map(tableColumns.map((column) => [column.key, column]));
const storage = typeof window === 'undefined' ? null : window.localStorage;

// Which ledger columns show and in what order; both persist in this browser under the existing keys.
export function useColumnSettings() {
  const [visibleColumns, setVisibleColumns] = useState(() => normalizeVisibleColumns(
    readStoredJson(storage, visibleColumnsStorageKey), columnKeys, defaultVisibleColumns
  ));
  const [columnOrder, setColumnOrder] = useState(() => normalizeColumnOrder(
    readStoredJson(storage, columnOrderStorageKey), columnKeys
  ));

  useEffect(() => writeStoredJson(storage, visibleColumnsStorageKey, visibleColumns), [visibleColumns]);
  useEffect(() => writeStoredJson(storage, columnOrderStorageKey, columnOrder), [columnOrder]);

  const activeColumns = useMemo(
    () => columnOrder.filter((key) => visibleColumns.includes(key)).map((key) => columnsByKey.get(key)),
    [columnOrder, visibleColumns]
  );

  return {
    allColumns: tableColumns,
    activeColumns,
    isVisible: (key) => visibleColumns.includes(key),
    toggleColumn: (key) => setVisibleColumns((current) => toggleKey(current, key)),
    moveColumn: (source, target, after) => setColumnOrder((current) => moveColumn(current, source, target, after))
  };
}
