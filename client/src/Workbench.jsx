import React, { useEffect, useImperativeHandle, useState } from 'react';
import { ArrowRight, FileSpreadsheet, RefreshCw } from 'lucide-react';
import { isAbort, requestJson } from './api.js';
import { DataTable, Loader, Metric, Notice } from './GroupRevenue.jsx';
import { changeTypes, dataFreshness } from './ledgerChanges.js';
import { strategicStatuses } from './StrategicCustomers.jsx';
import './workbench.css';

// The status moves get their own tiles; every other kind of change is summed into one.
const statusKinds = ['added', 'normalized', 'resumed', 'cancelled', 'stopped', 'status'];
const statusLabel = Object.fromEntries(strategicStatuses.map((item) => [item.key, item.label]));
const statusTone = Object.fromEntries(strategicStatuses.map((item) => [item.key, item.tone]));
const levelLabels = { cancel: '待销户', red: '红色', yellow: '黄色', green: '绿色' };
// Sorting puts the highest first: groups just lost need following up before new ones.
const moveUrgency = { lost: 3, untouched: 2, penetrated: 1 };

function percent(value, total) {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '—';
}

function lineMove(line) {
  return line.before === null ? `新增（${line.after || '空'}）` : `${line.before || '空'} → ${line.after || '空'}`;
}

function TodoRow({ title, count, detail, action, onAction }) {
  return (
    <li className="workbench-todo">
      <div>
        <span>{title}</span>
        <small>{detail}</small>
      </div>
      <strong className={count > 0 ? 'workbench-count-open' : undefined}>{count}</strong>
      <button type="button" onClick={onAction}>{count > 0 ? action : '查看'}<ArrowRight size={14} /></button>
    </li>
  );
}

function ImportSummary({ latest, onNavigate }) {
  const summary = latest.changes;
  if (!summary) return <p className="workbench-note">这次导入发生在变更记录上线之前，没有记录改了什么。</p>;
  if (summary.baseline) return <p className="workbench-note">这是第一次导入，作为之后对比的起点，所以没有变更。</p>;
  const others = changeTypes.filter((item) => !statusKinds.includes(item.key) && summary.counts[item.key] > 0);
  const otherTotal = others.reduce((sum, item) => sum + summary.counts[item.key], 0);
  return (
    <>
      <div className="workbench-tiles">
        {changeTypes.filter((item) => statusKinds.includes(item.key)).map((item) => (
          <div key={item.key} className="workbench-tile">
            <span>{item.label}</span>
            <strong className={summary.counts[item.key] > 0 ? item.tone : undefined}>{summary.counts[item.key] || 0}</strong>
          </div>
        ))}
        <div className="workbench-tile">
          <span>其他变化</span>
          <strong>{otherTotal}</strong>
        </div>
      </div>
      {others.length > 0 && <p className="workbench-note">其他变化：{others.map((item) => `${item.label} ${summary.counts[item.key]}`).join(' · ')}</p>}
      <div className="workbench-footer">
        <span>{summary.year} 年 KPI 净增 {summary.netBefore ?? '—'} → {summary.netAfter ?? '—'}</span>
        <button type="button" onClick={() => onNavigate({ view: 'imports', batchId: latest.id })}>查看变更明细<ArrowRight size={14} /></button>
      </div>
    </>
  );
}

function StrategicChanges({ strategic, onNavigate }) {
  if (!strategic.listed) {
    return (
      <div className="workbench-footer">
        <span className="workbench-note">还没有导入战客清单。</span>
        <button type="button" onClick={() => onNavigate({ view: 'operations', section: 'strategic' })}>去导入<ArrowRight size={14} /></button>
      </div>
    );
  }
  if (!strategic.changes.length) return <p className="workbench-note">这次导入没有战客集团的渗透状态发生变化。</p>;
  return (
    <DataTable rows={strategic.changes.map((row) => ({ ...row, urgency: moveUrgency[row.to] ?? 0 }))} rowKey="groupCode" initialSort="urgency" columns={[
      {
        key: 'groupName',
        label: '集团',
        render: (row) => (
          <button className="rev-link rev-cell-stack rev-group-name" onClick={() => onNavigate({ view: 'operations', section: 'strategic', groupCode: row.groupCode })}>
            <strong>{row.groupName || '未填写集团名称'}</strong><small>{row.groupCode}</small>
          </button>
        )
      },
      { key: 'managerName', label: '客户经理' },
      {
        key: 'urgency',
        label: '变化',
        render: (row) => <span><span className={statusTone[row.from]}>{statusLabel[row.from]}</span> → <strong className={statusTone[row.to]}>{statusLabel[row.to]}</strong></span>
      },
      {
        key: 'lines',
        label: '涉及专线',
        sortable: false,
        render: (row) => <div className="workbench-lines">{row.lines.map((line) => <span key={line.id}>{line.groupProductCode || `记录 ${line.id}`} {line.productName || ''}：{lineMove(line)}</span>)}</div>
      },
      { key: 'activeLines', label: '现在在网专线', numeric: true }
    ]} />
  );
}

/**
 * 工作台: what the latest ledger import changed and what is left to act on. Each part links to
 * the page where it is handled; nothing here is a figure of its own.
 */
export default function Workbench({ ref, kpiMode, refreshToken, onNavigate }) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ loading: true, data: null, error: '' });

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));
    requestJson(`/workbench?kpiMode=${kpiMode ? '1' : '0'}`, { signal: controller.signal })
      .then((data) => setState({ loading: false, data, error: '' }))
      .catch((error) => { if (!isAbort(error)) setState({ loading: false, data: null, error: error.message }); });
    return () => controller.abort();
  }, [kpiMode, refreshToken, revision]);

  const refresh = () => setRevision((value) => value + 1);
  useImperativeHandle(ref, () => ({ refresh }), []);

  const data = state.data;
  const kpi = data?.kpi;
  const latest = data?.latestImport;
  const lostCount = data?.strategic.changes.filter((row) => row.to === 'lost').length ?? 0;

  return (
    <main className="revenue-page workbench-page">
      <div className="rev-context">
        <span>{latest ? `最近导入：${latest.fileName || '未命名'} · ${dataFreshness(latest.importedAt)}` : data ? '还没有导入过台账' : '正在读取…'}</span>
        <span>台账范围：{kpiMode ? 'KPI 十类产品' : '全部产品'}</span>
      </div>
      {state.error && <Notice error>{state.error}<button onClick={refresh}><RefreshCw size={14} />重试</button></Notice>}

      {state.loading && !data ? <Loader /> : data && (
        <>
          <section className="rev-metrics" aria-label="KPI 进度">
            <Metric label={`${kpi.year} 年 KPI 净增`} value={kpi.actual.net} note={`目标 ${kpi.target} · 完成 ${percent(kpi.actual.net, kpi.target)} · 新增 ${kpi.actual.added}，销户 ${kpi.actual.cancelled}`} />
            <Metric label="距目标还差" value={Math.max(kpi.gap, 0)} className={kpi.gap <= 0 ? 'rev-positive' : ''} note={kpi.gap <= 0 ? `已超出目标 ${-kpi.gap}` : '目标减去当前净增'} />
            <Metric label="每月需净增" value={kpi.perMonth} note={`今年还剩 ${kpi.monthsLeft} 个月（含本月）`} />
            <Metric label="计入预计后还差" value={Math.max(kpi.gapAfterForecast, 0)} className={kpi.gapAfterForecast <= 0 ? 'rev-positive' : ''} note={`未落地的预计新增 ${kpi.forecast.added}、预计销户 ${kpi.forecast.cancelled}`} />
          </section>

          <div className="workbench-grid">
            <section className="rev-section">
              <div className="rev-section-heading"><h3>待处理</h3></div>
              <ul className="workbench-todos">
                <TodoRow
                  title="KPI 预计任务待确认落地"
                  count={kpi.suggestions}
                  detail="导入后出现的新专线或销户，可能对应已登记的预计任务"
                  action="去确认"
                  onAction={() => onNavigate({ view: 'operations', section: 'kpi' })}
                />
                <TodoRow
                  title="欠费预警未标注"
                  count={data.warnings.unmarked}
                  detail={Object.entries(levelLabels).map(([key, label]) => `${label} ${data.warnings.byLevel[key]}`).join(' · ')}
                  action="去处理"
                  onAction={() => onNavigate({ view: 'operations', section: 'warnings' })}
                />
                <TodoRow
                  title="这次导入后流失的战客集团"
                  count={lostCount}
                  detail={data.strategic.listed ? '已渗透变为已流失，明细见下方“战客异动”' : '还没有导入战客清单'}
                  action="查看"
                  onAction={() => onNavigate({ view: 'operations', section: 'strategic' })}
                />
              </ul>
            </section>

            <section className="rev-section">
              <div className="rev-section-heading">
                <h3>这次导入</h3>
                {latest && <span className="rev-caption">新增 {latest.addedRows} 条，更新 {latest.updatedRows} 条，失败 {latest.failedRows} 条</span>}
              </div>
              {latest ? <ImportSummary latest={latest} onNavigate={onNavigate} /> : (
                <div className="workbench-empty">
                  <FileSpreadsheet size={32} strokeWidth={1.4} />
                  <p>还没有导入过台账。点击顶部“导入 Excel”导入到达日清单。</p>
                </div>
              )}
            </section>
          </div>

          <section className="rev-section">
            <div className="rev-section-heading">
              <h3>战客异动 <span>{data.strategic.changes.length}</span></h3>
              <span className="rev-caption">这次导入前后渗透状态不同的战客集团</span>
            </div>
            {latest ? <StrategicChanges strategic={data.strategic} onNavigate={onNavigate} /> : <p className="workbench-note">导入台账后在这里显示。</p>}
          </section>
        </>
      )}
    </main>
  );
}
