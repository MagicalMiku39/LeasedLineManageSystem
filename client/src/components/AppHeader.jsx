import React, { useCallback, useRef, useState } from 'react';
import { Building2, ChevronDown, Download, FileSpreadsheet, History, ListChecks, LogOut, RefreshCw, Upload, UsersRound } from 'lucide-react';
import { useDismiss } from './useDismiss.js';

export const views = [
  { key: 'ledger', label: '台账', icon: FileSpreadsheet },
  { key: 'managers', label: '客户经理', icon: UsersRound },
  { key: 'revenue', label: '集团收入', icon: Building2 },
  { key: 'operations', label: '运营中心', icon: ListChecks },
  { key: 'imports', label: '导入记录', icon: History }
];

// "导出" with several choices: each item is { key, label, hint, run }.
function ExportMenu({ items }) {
  const container = useRef(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);

  return (
    <div className="export-menu-wrap" ref={container}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Download size={16} /> 导出 <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="export-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                item.run();
              }}
            >
              <span>{item.label}</span>
              {item.hint && <small>{item.hint}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The shared top bar: navigation, KPI scope and the import / export / refresh / logout
// actions. Each action is resolved by the current page (see App).
export default function AppHeader({
  activeView,
  onSelectView,
  kpiMode,
  onKpiModeChange,
  importAction,
  exportAction,
  onRefresh,
  refreshing = false,
  refreshTitle,
  onLogout
}) {
  return (
    <header className="app-header">
      <div className="app-title">
        <p>专线台账管理系统</p>
        <h1>台账工作台</h1>
      </div>
      <nav className="view-tabs" aria-label="主菜单">
        {views.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            className={activeView === key ? 'active' : ''}
            aria-current={activeView === key ? 'page' : undefined}
            onClick={() => onSelectView(key)}
          >
            <Icon size={16} aria-hidden="true" /> {label}
          </button>
        ))}
      </nav>
      <div className="header-actions">
        <label className={`kpi-mode-toggle${kpiMode ? ' active' : ''}`}>
          <span>KPI统计模式</span>
          <input type="checkbox" checked={kpiMode} onChange={(event) => onKpiModeChange(event.target.checked)} />
          <span className="kpi-toggle-track" aria-hidden="true">
            <span className="kpi-toggle-thumb" />
          </span>
        </label>
        {importAction.kind === 'dialog' ? (
          <button type="button" className="upload-button" title={importAction.title} onClick={importAction.open}>
            <Upload size={16} /> 导入 Excel
          </button>
        ) : (
          <label className={`upload-button${importAction.busy ? ' busy' : ''}`} title={importAction.title}>
            <Upload size={16} />
            {importAction.busy ? '导入中…' : '导入 Excel'}
            <input type="file" accept=".xlsx,.xls" onChange={importAction.onFile} disabled={importAction.busy} />
          </label>
        )}
        {exportAction.menu ? (
          <ExportMenu items={exportAction.menu} />
        ) : (
          <button type="button" disabled={exportAction.disabled} title={exportAction.title} onClick={exportAction.run}>
            <Download size={16} /> 导出
          </button>
        )}
        <button type="button" title={refreshTitle} onClick={onRefresh} aria-busy={refreshing}>
          <RefreshCw size={16} className={refreshing ? 'spin' : undefined} /> 刷新
        </button>
        <button type="button" onClick={onLogout}>
          <LogOut size={16} /> 退出
        </button>
      </div>
    </header>
  );
}
