import React, { useRef, useState } from 'react';
import { displayMoney, displayValue } from '../utils.js';

function cellContent(column, row) {
  const value = column.render ? column.render(row) : row[column.key];
  if (column.key === 'ledger_status') return <span className="status-pill">{displayValue(value)}</span>;
  return column.money ? displayMoney(value) : displayValue(value);
}

// The ledger grid: drag a header to reorder columns, click it to sort on the server,
// tick rows for batch editing, click a row to open its detail.
export default function LedgerTable({
  columns,
  rows,
  sort,
  onSort,
  onMoveColumn,
  selectedIds,
  onToggleRow,
  onToggleAll,
  onOpenRow,
  loading,
  emptyText
}) {
  const draggedColumn = useRef(null);
  const suppressSortUntil = useRef(0);
  const [columnDrop, setColumnDrop] = useState(null);

  function endDrag() {
    draggedColumn.current = null;
    // A drop also fires a click on the header; ignore it so a reorder never re-sorts.
    suppressSortUntil.current = Date.now() + 250;
    setColumnDrop(null);
  }

  function dropSide(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
  }

  function drop(event, target) {
    event.preventDefault();
    const source = draggedColumn.current;
    if (source && source !== target) onMoveColumn(source, target, dropSide(event) === 'after');
    endDrag();
  }

  return (
    <table className="data-table ledger-table">
      <thead>
        <tr>
          <th className="select-cell">
            <input
              aria-label="选择本页全部记录"
              type="checkbox"
              checked={rows.length > 0 && selectedIds.length === rows.length}
              onChange={(event) => onToggleAll(event.target.checked)}
            />
          </th>
          {columns.map((column) => {
            const isSorted = sort.key === column.key;
            const ascending = isSorted && sort.direction === 'asc';
            let ariaSort = 'none';
            if (isSorted) ariaSort = ascending ? 'ascending' : 'descending';
            return (
              <th
                key={column.key}
                draggable
                className={[column.money ? 'num' : '', columnDrop?.key === column.key ? `column-drop-${columnDrop.side}` : ''].filter(Boolean).join(' ') || undefined}
                onDragStart={(event) => {
                  draggedColumn.current = column.key;
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', column.key);
                }}
                onDragOver={(event) => {
                  if (!draggedColumn.current) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setColumnDrop({ key: column.key, side: dropSide(event) });
                }}
                onDrop={(event) => drop(event, column.key)}
                onDragEnd={endDrag}
                aria-sort={ariaSort}
              >
                <button
                  type="button"
                  className={`sort-header${isSorted ? ' active' : ''}`}
                  onClick={() => {
                    if (Date.now() >= suppressSortUntil.current) onSort(column.key);
                  }}
                  title={`按${column.label}${isSorted ? (ascending ? '升序' : '降序') : '排序'}`}
                >
                  <span>{column.label}</span>
                  <span className="sort-indicator" aria-hidden="true">{isSorted ? (ascending ? '↑' : '↓') : '↕'}</span>
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            className="clickable-row"
            tabIndex={0}
            onClick={() => onOpenRow(row.id)}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                onOpenRow(row.id);
              }
            }}
          >
            <td className="select-cell" onClick={(event) => event.stopPropagation()}>
              <input
                aria-label={`选择 ${row.group_product_code || row.group_user_name || row.id}`}
                type="checkbox"
                checked={selectedIds.includes(row.id)}
                onChange={() => onToggleRow(row.id)}
              />
            </td>
            {columns.map((column) => (
              <td key={column.key} className={column.money ? 'num' : undefined}>{cellContent(column, row)}</td>
            ))}
          </tr>
        ))}
        {rows.length === 0 && (
          <tr className="state-row">
            <td colSpan={columns.length + 1} className="empty">{loading ? '正在读取台账…' : emptyText}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
