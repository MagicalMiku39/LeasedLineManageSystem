import React, { useEffect, useRef, useState } from 'react';
import { ListChecks, UsersRound } from 'lucide-react';
import { isAbort, requestJson } from './api.js';
import { InlineError } from './components/Feedback.jsx';
import MultiSelectFilter from './components/MultiSelectFilter.jsx';
import { defaultManagers } from './ledger/config.js';
import { money, netClass, signedMoney, signedNumber } from './utils.js';

const day = (value) => (value ? String(value).slice(0, 10) : '—');

const sortOptions = [
  { value: 'yearScaleNet', label: '年度规模净增' },
  { value: 'yearIncomeNet', label: '年度收入净增' },
  { value: 'quarterScaleNet', label: '季度规模净增' },
  { value: 'quarterIncomeNet', label: '季度收入净增' },
  { value: 'monthScaleNet', label: '月度规模净增' },
  { value: 'monthIncomeNet', label: '月度收入净增' }
];

const periods = [
  { key: 'month', label: '本月' },
  { key: 'quarter', label: '本季度' },
  { key: 'year', label: '本年度' }
];

// Net additions per manager for the chosen month, quarter and year. Loads only while the page
// is open; an empty selection means every manager.
export function useManagerPerformance({ enabled, month, sort, selection, kpiMode }) {
  const [state, setState] = useState({ data: null, loading: false, error: '' });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    const params = new URLSearchParams({ month, sort, kpiMode: kpiMode ? '1' : '0' });
    if (selection.length > 0) params.set('managers', selection.join('|'));
    setState((current) => ({ ...current, loading: true, error: '' }));
    requestJson(`/manager-performance?${params.toString()}`, { signal: controller.signal })
      .then((data) => setState({ data, loading: false, error: '' }))
      .catch((error) => {
        if (isAbort(error)) return;
        setState({ data: { rows: [] }, loading: false, error: `客户经理统计加载失败：${error.message}` });
      });
    return () => controller.abort();
  }, [enabled, month, sort, selection, kpiMode, revision]);

  return { ...state, reload: () => setRevision((value) => value + 1) };
}

function sameSet(left, right) {
  return left.length === right.length && right.every((item) => left.includes(item));
}

function NetCell({ scale, income }) {
  return (
    <div className="manager-net-cell">
      <strong className={netClass(scale)}>{signedNumber(scale)}</strong>
      <span className={netClass(income)}>{signedMoney(income)} 元</span>
    </div>
  );
}

function DetailCell({ addedCount, cancelledCount, addedIncome, cancelledIncome }) {
  return (
    <div className="manager-detail-cell">
      <span>新增 {addedCount || 0} 条 / {money(addedIncome)} 元</span>
      <span>销户 {cancelledCount || 0} 条 / {money(cancelledIncome)} 元</span>
    </div>
  );
}

function LinesTable({ rows, timeField, timeLabel, onOpenLine, onOpenGroup }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr><th>集团</th><th>集团产品编码</th><th>产品名称</th><th>状态</th><th>{timeLabel}</th><th className="num">月资费</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="manager-lines-wrap">
                {row.group_name || '未填写集团名称'}
                <small>{row.group_code && onOpenGroup
                  ? <button type="button" className="group-link" title="查看集团档案" onClick={() => onOpenGroup(row.group_code)}>{row.group_code} · 集团档案</button>
                  : row.group_code || '—'}</small>
              </td>
              <td><button type="button" className="group-link" title="查看专线详情" onClick={() => onOpenLine(row.id)}>{row.group_product_code || `记录 ${row.id}`}</button></td>
              <td>{row.product_name || '—'}</td>
              <td>{row.status_name || '—'}</td>
              <td>{day(row[timeField])}</td>
              <td className="num">{money(row.monthly_fee)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The lines behind one manager's figures, for the month, quarter or year of the chosen month.
function ManagerLines({ manager, month, kpiMode, onOpenLine, onOpenGroup, onClose }) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const [period, setPeriod] = useState('year');
  const [revision, setRevision] = useState(0);
  const panel = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));
    requestJson(`/manager-performance/lines?${new URLSearchParams({ month, manager, kpiMode: kpiMode ? '1' : '0' })}`, { signal: controller.signal })
      .then((data) => setState({ data, loading: false, error: '' }))
      .catch((error) => { if (!isAbort(error)) setState({ data: null, loading: false, error: `明细加载失败：${error.message}` }); });
    return () => controller.abort();
  }, [manager, month, kpiMode, revision]);

  useEffect(() => {
    panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [manager]);

  const added = (state.data?.added || []).filter((row) => row.periods.includes(period));
  const cancelled = (state.data?.cancelled || []).filter((row) => row.periods.includes(period));
  const sum = (rows) => rows.reduce((total, row) => total + row.monthly_fee, 0);
  const label = periods.find((item) => item.key === period).label;

  return (
    <section className="manager-lines" ref={panel} aria-label={`${manager}的新增与销户明细`}>
      <div className="manager-lines-head">
        <h3>{manager} · 新增与销户明细</h3>
        <div className="scope-actions" role="group" aria-label="统计周期">
          {periods.map((item) => (
            <button key={item.key} type="button" aria-pressed={period === item.key} onClick={() => setPeriod(item.key)}>{item.label}</button>
          ))}
          <button type="button" onClick={onClose}>收起</button>
        </div>
      </div>
      <InlineError message={state.error} onRetry={() => setRevision((value) => value + 1)} />
      {state.loading && !state.data && <p className="manager-lines-sum" role="status">正在读取明细…</p>}
      {state.data && (
        <>
          <p className="manager-lines-sum">
            {label}：新增 {added.length} 条 / {money(sum(added))} 元，销户 {cancelled.length} 条 / {money(sum(cancelled))} 元，
            净增 <strong className={netClass(added.length - cancelled.length)}>{signedNumber(added.length - cancelled.length)}</strong> 条。
            新增按开始时间，销户按状态时间。
          </p>
          <h4>新增 {added.length} 条</h4>
          {added.length ? <LinesTable rows={added} timeField="start_time" timeLabel="开始时间" onOpenLine={onOpenLine} onOpenGroup={onOpenGroup} /> : <p className="manager-lines-sum">{label}没有新增</p>}
          <h4>销户 {cancelled.length} 条</h4>
          {cancelled.length ? <LinesTable rows={cancelled} timeField="status_time" timeLabel="销户时间" onOpenLine={onOpenLine} onOpenGroup={onOpenGroup} /> : <p className="manager-lines-sum">{label}没有销户</p>}
        </>
      )}
    </section>
  );
}

export default function ManagerDashboard({
  month,
  setMonth,
  options,
  selectedManagers,
  setSelectedManagers,
  sort,
  setSort,
  data,
  loading,
  error,
  reload,
  kpiMode,
  onOpenLine,
  onOpenGroup
}) {
  const rows = data?.rows || [];
  // The manager whose lines are listed under the table; a second click on the name closes it.
  const [openManager, setOpenManager] = useState(null);
  const shownManager = rows.some((row) => row.manager_name === openManager) ? openManager : null;
  const showingAll = selectedManagers.length === 0;
  const showingDefaults = sameSet(selectedManagers, defaultManagers);
  const managerOptions = [...new Set([...defaultManagers, ...(options.managers || []), ...selectedManagers])];

  return (
    <main className="page manager-page">
      <div className="page-heading">
        <h2>客户经理规模与收入净增</h2>
        <p>按所选月份统计本月、所在季度和年度；新增按开始时间，销户按状态时间。收入净增为月资费净增。点击客户经理姓名，在表格下方查看新增与销户明细。</p>
      </div>

      <section className="manager-controls" aria-label="客户经理统计条件">
        <label className="month-field">
          统计月份
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </label>
        <label className="select-field">
          从高到低排序
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <MultiSelectFilter
          label="选择客户经理"
          clearLabel="查看全部"
          value={selectedManagers}
          options={managerOptions}
          onChange={setSelectedManagers}
        />
        <div className="scope-actions" role="group" aria-label="客户经理快捷筛选">
          <button type="button" aria-pressed={showingAll} onClick={() => setSelectedManagers([])}>
            <UsersRound size={15} /> 查看全部客户经理
          </button>
          <button type="button" aria-pressed={showingDefaults} onClick={() => setSelectedManagers([...defaultManagers])}>
            <ListChecks size={15} /> 指定18位客户经理
          </button>
        </div>
      </section>

      <InlineError message={error} onRetry={reload} />

      <section className="table-shell manager-table-shell">
        <div className="table-title">
          <div className="table-title-left">
            <span className="table-count">客户经理排名</span>
            <strong>{showingAll ? '全部客户经理' : `已选 ${selectedManagers.length} 人`}</strong>
            {loading && <em>加载中</em>}
          </div>
          <span className="subtle">
            {data?.year || month.slice(0, 4)} 年 · 第 {data?.quarter || '—'} 季度 · {data?.month || month} · 共 {rows.length} 人
          </span>
        </div>
        <div className="table-scroll manager-table-scroll">
          <table className="data-table manager-table">
            <thead>
              <tr>
                <th>客户经理</th>
                {periods.map((period) => (
                  <React.Fragment key={period.key}>
                    <th className="num">{period.label}净增</th>
                    <th>{period.label}明细</th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.manager_name} className={shownManager === row.manager_name ? 'manager-open' : undefined}>
                  <td>
                    <button
                      type="button"
                      className="group-link manager-name-button"
                      aria-expanded={shownManager === row.manager_name}
                      title="查看新增与销户明细"
                      onClick={() => setOpenManager(shownManager === row.manager_name ? null : row.manager_name)}
                    >
                      {row.manager_name}
                    </button>
                  </td>
                  {periods.map(({ key }) => (
                    <React.Fragment key={key}>
                      <td className="num"><NetCell scale={row[`${key}_scale_net`]} income={row[`${key}_income_net`]} /></td>
                      <td>
                        <DetailCell
                          addedCount={row[`${key}_added_count`]}
                          cancelledCount={row[`${key}_cancelled_count`]}
                          addedIncome={row[`${key}_added_income`]}
                          cancelledIncome={row[`${key}_cancelled_income`]}
                        />
                      </td>
                    </React.Fragment>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr className="state-row">
                  <td colSpan="7" className="empty">{loading ? '正在统计…' : '暂无客户经理统计数据'}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {shownManager && (
        <ManagerLines
          key={shownManager}
          manager={shownManager}
          month={month}
          kpiMode={kpiMode}
          onOpenLine={onOpenLine}
          onOpenGroup={onOpenGroup}
          onClose={() => setOpenManager(null)}
        />
      )}
    </main>
  );
}
