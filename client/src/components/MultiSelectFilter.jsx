import React, { useCallback, useRef, useState } from 'react';
import { toggleKey } from '../ledger/columnSettings.js';
import { useDismiss } from './useDismiss.js';

// Multi-value filter: values inside one filter are OR-ed; the server AND-s different filters.
export default function MultiSelectFilter({ value, onChange, options, label, clearLabel = '清空' }) {
  const selected = Array.isArray(value) ? value : [];
  const container = useRef(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    if (container.current) container.current.open = false;
    setOpen(false);
  }, []);
  useDismiss(container, open, close);

  return (
    <details
      className="multi-select"
      ref={container}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && container.current?.open) {
          event.stopPropagation();
          close();
          container.current.querySelector('summary')?.focus();
        }
      }}
    >
      <summary aria-label={selected.length > 0 ? `${label}，已选 ${selected.length} 项` : label}>
        {selected.length > 0 ? `${label}（${selected.length}）` : label}
      </summary>
      <div className="multi-select-menu">
        <div className="multi-select-actions">
          <span>已选 {selected.length} 项</span>
          <button type="button" onClick={() => onChange([])}>{clearLabel}</button>
        </div>
        {options.length === 0 && <div className="multi-select-empty">暂无可选项</div>}
        {options.map((option) => (
          <label key={option}>
            <input type="checkbox" checked={selected.includes(option)} onChange={() => onChange(toggleKey(selected, option))} />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </details>
  );
}
