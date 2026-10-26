import React, { useCallback, useRef, useState } from 'react';
import { CheckSquare, Columns3, Search, SlidersHorizontal } from 'lucide-react';
import { InlineError } from '../components/Feedback.jsx';
import MultiSelectFilter from '../components/MultiSelectFilter.jsx';
import { useDismiss } from '../components/useDismiss.js';
import { money } from '../utils.js';
import { advancedFilterKeys, ledgerPageSize, statCards } from './config.js';
import LedgerTable from './LedgerTable.jsx';
import { countActiveFilters } from './query.js';

function hasAnyFilter(filters) {
  return Object.values(filters).some((value) => (Array.isArray(value) ? value.length > 0 : Boolean(value)));
}

function PeriodSummary({ title, added, cancelled }) {
  return (
    <div className="period-summary">
      <span className="period-title">{title}</span>
      <span className="period-added">新增 <b>{added || 0}</b></span>
      <span className="period-cancelled">销户 <b>{cancelled || 0}</b></span>
    </div>
  );
}

// Statistics month, the year and quarter totals, and the clickable statistics. A statistic
// filters the ledger only when it is clicked; the month alone changes no ledger filter.
function LedgerOverview({ stats, statsError, onRetryStats, month, onMonthChange, activeStat, onApplyStat }) {
  const currentYear = stats?.currentYear || new Date().getFullYear();
  return (
    <section className="ledger-overview" aria-label="台账统计">
      <div className="overview-period">
        <label className="month-field">
          统计月份
          <input type="month" value={month} onChange={(event) => onMonthChange(event.target.value)} />
        </label>
        <PeriodSummary title={`${currentYear} 年`} added={stats?.addedInCurrentYear} cancelled={stats?.cancelledInCurrentYear} />
        <PeriodSummary
          title={`第 ${stats?.currentQuarter || 1} 季度`}
          added={stats?.addedInCurrentQuarter}
          cancelled={stats?.cancelledInCurrentQuarter}
        />
      </div>
      <InlineError message={statsError && `统计读取失败：${statsError}`} onRetry={onRetryStats} />
      <div className="stat-strip">
        {statCards.map((card) => {
          const active = card.filter ? activeStat === card.filter : !activeStat;
          return (
            <button
              key={card.label}
              type="button"
              className={`stat-cell${active ? ' active' : ''}`}
              aria-pressed={active}
              title={card.filter ? `只看${card.label}` : '清空筛选，查看全部专线'}
              onClick={() => onApplyStat(card.filter)}
            >
              <span>{card.label}</span>
              <strong>{stats?.[card.field] || 0}</strong>
            </button>
          );
        })}
        <div className="stat-cell stat-cell-static">
          <span>预计总出账</span>
          <strong>{money(stats?.expectedTotalBilling)}<small> 元</small></strong>
        </div>
      </div>
    </section>
  );
}

function AdvancedFilters({ filters, options, onChange }) {
  const textField = (key, label, placeholder) => (
    <label>
      {label}
      <input value={filters[key]} onChange={(event) => onChange(key, event.target.value)} placeholder={placeholder} />
    </label>
  );
  const dateField = (key, label) => (
    <label>
      {label}
      <input type="date" value={filters[key]} onChange={(event) => onChange(key, event.target.value)} />
    </label>
  );

  return (
    <div className="advanced-filters" id="ledger-advanced-filters">
      {textField('groupCode', '集团编码', '支持模糊匹配')}
      {textField('groupProductCode', '集团产品编码', '支持模糊匹配')}
      {textField('productCode', '产品编码', '如 pg.dt.zx.cs')}
      {textField('bandwidth', '专线带宽', '如 10M、100')}
      <label>
        最近半年出账为 0
        <select value={filters.zeroBilling} onChange={(event) => onChange('zeroBilling', event.target.value)}>
          <option value="">全部</option>
          {(options.zeroBillingOptions || []).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>
      {dateField('contractEndFrom', '合同到期起')}
      {dateField('contractEndTo', '合同到期止')}
    </div>
  );
}

function ColumnMenu({ columns }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(wrap, open, close);

  return (
    <div className="column-menu-wrap" ref={wrap}>
      <button type="button" aria-expanded={open} aria-controls="ledger-column-menu" onClick={() => setOpen(!open)}>
        <Columns3 size={16} /> 显示字段
      </button>
      {open && (
        <div className="column-menu" id="ledger-column-menu">
          {columns.allColumns.map((column) => (
            <label key={column.key}>
              <input type="checkbox" checked={columns.isVisible(column.key)} onChange={() => columns.toggleColumn(column.key)} />
              {column.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function Pager({ page, totalPages, total, onPage }) {
  const first = total === 0 ? 0 : (page - 1) * ledgerPageSize + 1;
  const last = Math.min(total, page * ledgerPageSize);
  return (
    <div className="pager">
      <span className="pager-range">{total === 0 ? '无记录' : `第 ${first}–${last} 条，共 ${total} 条`}</span>
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
      <span>{page} / {totalPages}</span>
      <button disabled={page >= totalPages} onClick={() => onPage(page + 1)}>下一页</button>
    </div>
  );
}

export default function LedgerView({
  stats,
  statsError,
  onRetryStats,
  month,
  onMonthChange,
  filters,
  options,
  onFilterChange,
  onClearFilters,
  onApplyStat,
  showAdvanced,
  onToggleAdvanced,
  ledger,
  columns,
  onBatchEdit,
  onOpenRow
}) {
  const advancedFilterCount = countActiveFilters(filters, advancedFilterKeys);
  const filtered = hasAnyFilter(filters);

  return (
    <main className="page ledger-page">
      <LedgerOverview
        stats={stats}
        statsError={statsError}
        onRetryStats={onRetryStats}
        month={month}
        onMonthChange={onMonthChange}
        activeStat={filters.statFilter}
        onApplyStat={onApplyStat}
      />

      <section className="toolbar" aria-label="台账筛选">
        <label className="search-box">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="搜索台账"
            value={filters.keyword}
            onChange={(event) => onFilterChange('keyword', event.target.value)}
            placeholder="搜索集团编码、产品编码、客户、产品、经理、地址"
          />
        </label>
        <MultiSelectFilter label="归属区分" value={filters.region} options={options.regions || []} onChange={(value) => onFilterChange('region', value)} />
        <MultiSelectFilter label="产品名称" value={filters.product} options={options.products || []} onChange={(value) => onFilterChange('product', value)} />
        <MultiSelectFilter label="产品状态" value={filters.status} options={options.statuses || []} onChange={(value) => onFilterChange('status', value)} />
        <MultiSelectFilter label="客户经理" value={filters.manager} options={options.managers || []} onChange={(value) => onFilterChange('manager', value)} />
        <button
          type="button"
          className={`advanced-toggle${showAdvanced ? ' active' : ''}`}
          aria-expanded={showAdvanced}
          aria-controls="ledger-advanced-filters"
          onClick={onToggleAdvanced}
        >
          <SlidersHorizontal size={16} />
          高级筛选
          {advancedFilterCount > 0 && <span className="count-badge">{advancedFilterCount}</span>}
        </button>
        <button type="button" onClick={onClearFilters} disabled={!filtered}>清空筛选</button>
      </section>
      {showAdvanced && <AdvancedFilters filters={filters} options={options} onChange={onFilterChange} />}

      <section className="table-shell">
        <div className="table-title">
          <div className="table-title-left">
            <span className="table-count">共 {ledger.total} 条记录</span>
            {ledger.loading && ledger.loaded && <em>正在更新</em>}
            {ledger.selectedIds.length > 0 && <strong>已选 {ledger.selectedIds.length} 条</strong>}
          </div>
          <div className="table-actions">
            <button type="button" disabled={ledger.selectedIds.length === 0} onClick={onBatchEdit} title={ledger.selectedIds.length === 0 ? '先勾选需要编辑的记录' : undefined}>
              <CheckSquare size={16} /> 批量编辑
            </button>
            <ColumnMenu columns={columns} />
          </div>
        </div>
        <InlineError message={ledger.error && `台账读取失败：${ledger.error}`} onRetry={ledger.reload} />

        <div className="table-scroll">
          <LedgerTable
            columns={columns.activeColumns}
            rows={ledger.rows}
            sort={ledger.sort}
            onSort={ledger.toggleSort}
            onMoveColumn={columns.moveColumn}
            selectedIds={ledger.selectedIds}
            onToggleRow={ledger.toggleRow}
            onToggleAll={ledger.toggleAllRows}
            onOpenRow={onOpenRow}
            loading={ledger.loading && !ledger.loaded}
            emptyText={filtered ? '没有符合当前筛选条件的专线' : '暂无数据，请先导入 Excel'}
          />
        </div>

        <Pager page={ledger.page} totalPages={ledger.totalPages} total={ledger.total} onPage={ledger.setPage} />
      </section>
    </main>
  );
}
