import React, { useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { Building2, ChevronRight, Download, FileSpreadsheet, ListChecks, RefreshCw, Search, Upload, UsersRound, X } from 'lucide-react';
import { apiBase, isAbort, jsonBody, requestJson } from './api.js';
import { DataTable, Loader, Metric, Notice } from './GroupRevenue.jsx';
import { defaultManagers } from './ledger/config.js';
import { beijingTime, money } from './utils.js';

export const strategicStatuses = [
  { key: 'penetrated', label: '已渗透', tone: 'rev-positive' },
  { key: 'lost', label: '已流失', tone: 'rev-negative' },
  { key: 'untouched', label: '未渗透', tone: '' }
];
const statusLabel = Object.fromEntries(strategicStatuses.map((item) => [item.key, item.label]));
const statusTone = Object.fromEntries(strategicStatuses.map((item) => [item.key, item.tone]));
// What the group list can be narrowed to; 未渗透+已流失 is every group without a line in service.
const statusFilters = [
  { key: 'all', label: '全部', test: () => true },
  { key: 'penetrated', label: '已渗透', test: (row) => row.status === 'penetrated' },
  { key: 'lost', label: '已流失', test: (row) => row.status === 'lost' },
  { key: 'untouched', label: '未渗透', test: (row) => row.status === 'untouched' },
  { key: 'notPenetrated', label: '未渗透+已流失', test: (row) => row.status !== 'penetrated' }
];
const filterByKey = Object.fromEntries(statusFilters.map((item) => [item.key, item]));
const lineKinds = { active: '在网', cancelled: '已销户', other: '未开通或回退' };
const day = (value) => (value ? String(value).slice(0, 10) : '—');
const percent = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
const downloadTemplate = () => { window.location.href = `${apiBase}/strategic/template`; };

function useStrategic(path, revision) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  useEffect(() => {
    if (!path) {
      setState({ loading: false, data: null, error: '' });
      return undefined;
    }
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));
    requestJson(path, { signal: controller.signal })
      .then((data) => setState({ loading: false, data, error: '' }))
      .catch((error) => { if (!isAbort(error)) setState({ loading: false, data: null, error: error.message }); });
    return () => controller.abort();
  }, [path, revision]);
  return state;
}

function tally(rows) {
  const counts = { total: rows.length, penetrated: 0, lost: 0, untouched: 0, activeLines: 0, activeMonthlyFee: 0 };
  for (const row of rows) {
    counts[row.status] += 1;
    counts.activeLines += row.activeLines;
    counts.activeMonthlyFee += row.activeMonthlyFee;
  }
  return { ...counts, notPenetrated: counts.lost + counts.untouched, penetrationRate: counts.total > 0 ? counts.penetrated / counts.total : null };
}

/**
 * One row per manager on the list. With the 18 managers selected, each of them has a row even
 * when no strategic group is theirs, so a gap shows as 0 rather than disappearing.
 */
function managerReport(groups, onlyDefaults) {
  const byManager = new Map(onlyDefaults ? defaultManagers.map((name) => [name, []]) : []);
  for (const row of groups) {
    const name = row.managerName || '';
    if (!byManager.has(name)) byManager.set(name, []);
    byManager.get(name).push(row);
  }
  return [...byManager].map(([name, rows]) => ({ name, ...tally(rows) }));
}

// Reading the file changes nothing; the list is replaced only after the confirmation.
function ImportPanel({ onDone, onClose }) {
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function choose(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    setPreview(null);
    const form = new FormData();
    form.append('file', file);
    try {
      setPreview(await requestJson('/strategic/preview', { method: 'POST', body: form }));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  async function commit() {
    setBusy(true);
    setError('');
    try {
      onDone(await requestJson('/strategic/commit', jsonBody('POST', { token: preview.token })));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rev-import-panel" aria-label="战客清单导入">
      <div className="rev-section-heading">
        <h3>导入战客清单</h3>
        <button title="关闭导入" aria-label="关闭导入" onClick={onClose} disabled={busy}><X size={16} /></button>
      </div>
      <div className="rev-import-file">
        <FileSpreadsheet size={28} />
        <div>
          <strong>{preview?.fileName || '战客清单'}</strong>
          <small>Excel · 最多 32 MB · 按模板填写集团编码、集团名称、客户经理，三列必填；编码按文本处理</small>
        </div>
        <button type="button" onClick={downloadTemplate} disabled={busy}><Download size={16} />下载模板</button>
        <label className="rev-upload">{busy ? '处理中…' : '选择文件'}<input type="file" accept=".xlsx,.xls" onChange={choose} disabled={busy} /></label>
      </div>
      {error && <Notice error>{error}</Notice>}
      {preview && (
        <>
          <dl className="strategic-preview">
            <dt>战客集团</dt><dd>{preview.rowCount} 个</dd>
            <dt>台账中有专线记录</dt><dd>{preview.inLedger} 个</dd>
            <dt>与现有清单相比</dt><dd>{preview.replacing ? `新增 ${preview.added} 个，移出 ${preview.removed} 个` : '首次导入'}</dd>
            <dt>识别的列</dt><dd>{[preview.columns.group_code, preview.columns.group_name, preview.columns.manager_name].join('、')}</dd>
          </dl>
          {(preview.incomplete > 0 || preview.duplicates > 0) && (
            <ul className="rev-notes">
              {preview.incomplete > 0 && (
                <li>
                  {preview.incomplete} 行有缺项，不会导入：
                  {preview.incompleteRows.map((item) => `第 ${item.row} 行缺${item.missing.join('、')}`).join('；')}
                  {preview.incomplete > preview.incompleteRows.length ? ' 等' : ''}。
                </li>
              )}
              {preview.duplicates > 0 && <li>{preview.duplicates} 行集团编码重复，保留第一行。</li>}
            </ul>
          )}
          <div className="rev-actions">
            <button className="primary" disabled={busy} onClick={commit}><Upload size={16} />{busy ? '正在导入…' : preview.replacing ? '确认替换战客清单' : '确认导入'}</button>
            {preview.replacing && <span>整份替换：不在新清单里的集团不再算战客。</span>}
          </div>
        </>
      )}
    </section>
  );
}

// Sorting puts the highest rank first: lines in service, then cancelled, then the rest.
const kindRanks = { active: 3, cancelled: 2, other: 1 };

function GroupDetail({ data, onOpenLine }) {
  const { group, lines } = data;
  const rankedLines = useMemo(() => lines.map((line) => ({ ...line, kindRank: kindRanks[line.kind] })), [lines]);
  return (
    <>
      <div className="rev-group-heading">
        <div>
          <span className="rev-eyebrow">{group.groupCode}</span>
          <h2>{group.groupName || '未填写集团名称'}</h2>
          <p>{group.managerName || '客户经理未知'}</p>
        </div>
        <span className={`rev-label strategic-status-${group.status}`}>{statusLabel[group.status]}</span>
      </div>
      <section className="rev-metrics" aria-label="集团概览">
        <Metric label="在网专线" value={group.activeLines} note="正常在用、停机执行中、停机" />
        <Metric label="已销户专线" value={group.cancelledLines} />
        <Metric label="在网月资费" value={money(group.activeMonthlyFee)} note="实际月资费优先，否则活动套餐资费" />
        <Metric label="台账记录" value={lines.length} note="含未开通或回退" />
      </section>
      <section className="rev-section">
        <div className="rev-section-heading"><h3>集团专线 <span>{lines.length}</span></h3><span className="rev-caption">点击集团产品编码查看专线详情</span></div>
        <DataTable rows={rankedLines} rowKey="id" initialSort="kindRank" columns={[
          { key: 'group_product_code', label: '集团产品编码', render: (row) => <button className="rev-link" onClick={() => onOpenLine(row.id)}>{row.group_product_code || `记录 ${row.id}`}</button> },
          { key: 'kindRank', label: '类别', render: (row) => <span className={row.kind === 'active' ? 'rev-positive' : row.kind === 'cancelled' ? 'rev-negative' : ''}>{lineKinds[row.kind]}</span> },
          { key: 'group_user_name', label: '专线名称' },
          { key: 'product_name', label: '产品名称' },
          { key: 'status', label: '状态' },
          { key: 'bandwidth', label: '带宽' },
          { key: 'start_time', label: '开始时间', render: (row) => day(row.start_time) },
          { key: 'status_time', label: '状态时间', render: (row) => day(row.status_time) },
          { key: 'monthly_fee', label: '月资费', numeric: true, render: (row) => money(row.monthly_fee) }
        ]} empty="台账中没有这个集团的专线" />
      </section>
    </>
  );
}

/**
 * 战客专线渗透: every group on the strategic customer list, by whether it has lines in service
 * (已渗透), had them and lost them all (已流失), or never had any (未渗透); by group, or as a
 * penetration report per manager.
 */
export default function StrategicCustomers({ ref, kpiMode, refreshToken, onOpenLine, focus }) {
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState('groups');
  const [manager, setManager] = useState(null);
  const [status, setStatus] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [onlyDefaults, setOnlyDefaults] = useState(false);
  const [group, setGroup] = useState(null);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState('');
  const [exportError, setExportError] = useState('');
  const query = `kpiMode=${kpiMode ? '1' : '0'}`;
  const overview = useStrategic(`/strategic?${query}`, `${revision}:${refreshToken}`);
  const detail = useStrategic(group ? `/strategic/groups/${encodeURIComponent(group)}?${query}` : null, `${revision}:${refreshToken}`);
  const refresh = () => setRevision((value) => value + 1);

  // Another page (the 工作台) can open one group directly; each request carries its own nonce.
  useEffect(() => {
    if (!focus?.groupCode) return;
    setManager(null);
    setGroup(focus.groupCode);
  }, [focus]);

  const all = overview.data?.groups || [];
  const scoped = useMemo(() => all.filter((row) => (manager === null
    ? !onlyDefaults || defaultManagers.includes(row.managerName)
    : (row.managerName || '') === manager)), [all, onlyDefaults, manager]);
  const totals = useMemo(() => tally(scoped), [scoped]);
  const managers = useMemo(() => managerReport(scoped, onlyDefaults && manager === null), [scoped, onlyDefaults, manager]);
  const rows = useMemo(() => scoped.filter((row) => filterByKey[status].test(row)
    && `${row.groupCode} ${row.groupName || ''} ${row.managerName || ''}`.includes(keyword.trim())), [scoped, status, keyword]);
  const showingManagers = view === 'managers' && manager === null;

  function switchView(next) {
    setView(next);
    setManager(null);
  }

  function openManager(name) {
    setManager(name);
    setStatus('all');
    setView('groups');
  }

  useImperativeHandle(ref, () => ({
    refresh,
    openImport: () => setImporting(true),
    exportData: async () => {
      const exportRows = group ? detail.data?.lines : showingManagers ? managers : rows;
      if (!exportRows?.length) return;
      setExportError('');
      try {
        const module = await import('xlsx');
        const XLSX = module.default || module;
        const book = XLSX.utils.book_new();
        const reportRow = (row, name) => ({ 客户经理: name, 战客集团: row.total, 已渗透: row.penetrated, 渗透率: row.penetrationRate, 已流失: row.lost, 未渗透: row.untouched, '未渗透+已流失': row.notPenetrated, 在网专线: row.activeLines, 在网月资费: row.activeMonthlyFee });
        const sheet = group
          ? exportRows.map((row) => ({ 集团产品编码: row.group_product_code, 类别: lineKinds[row.kind], 专线名称: row.group_user_name, 产品名称: row.product_name, 状态: row.status, 带宽: row.bandwidth, 开始时间: day(row.start_time), 状态时间: day(row.status_time), 月资费: row.monthly_fee }))
          : showingManagers
            ? [...exportRows.map((row) => reportRow(row, row.name || '未填写')), reportRow(totals, '合计')]
            : exportRows.map((row) => ({ 集团编码: row.groupCode, 集团名称: row.groupName, 客户经理: row.managerName, 渗透状态: statusLabel[row.status], 在网专线: row.activeLines, 已销户专线: row.cancelledLines, 在网月资费: row.activeMonthlyFee, 最早在网开通: day(row.firstStartAt), 最近销户: day(row.lastCancelledAt) }));
        const worksheet = XLSX.utils.json_to_sheet(sheet);
        if (showingManagers && !group) {
          sheet.forEach((_, index) => {
            const cell = worksheet[XLSX.utils.encode_cell({ r: index + 1, c: 3 })];
            if (cell?.t === 'n') cell.z = '0.0%';
          });
        }
        XLSX.utils.book_append_sheet(book, worksheet, group ? '集团专线' : showingManagers ? '客户经理渗透率' : '战客渗透');
        XLSX.writeFile(book, group
          ? `战客专线-${group}.xlsx`
          : showingManagers ? '战客渗透率-客户经理.xlsx' : `战客专线渗透-${manager !== null ? `${manager || '未填写'}-` : ''}${filterByKey[status].label}.xlsx`);
      } catch (failure) {
        setExportError(`导出失败：${failure.message}`);
      }
    }
  }), [group, detail.data, rows, managers, totals, showingManagers, manager, status]);

  const list = overview.data?.list;
  const failure = group ? detail.error : overview.error;
  const loading = group ? detail.loading : overview.loading;

  return (
    <div className="revenue-page strategic-page">
      <div className="rev-toolbar">
        <div className="rev-breadcrumbs">
          <button onClick={() => { setGroup(null); setManager(null); }}>战客总览</button>
          {manager !== null && <><ChevronRight size={14} /><button onClick={() => setGroup(null)}>{manager || '未填写客户经理'}</button></>}
          {group && <><ChevronRight size={14} /><span>集团详情</span></>}
        </div>
      </div>
      <div className="rev-context">
        <span>{list ? `战客清单：${list.file_name || '未命名'} · ${list.row_count} 个集团 · ${beijingTime(list.imported_at)} 导入` : '还没有导入战客清单'}</span>
        <span>台账范围：{kpiMode ? 'KPI 十类产品' : '全部产品'} · 在网 = 正常在用、停机执行中、停机</span>
      </div>
      {message && <div className="rev-success" role="status">{message}<button title="关闭提示" aria-label="关闭提示" onClick={() => setMessage('')}><X size={14} /></button></div>}
      {exportError && <Notice error>{exportError}</Notice>}
      {importing && (
        <ImportPanel
          onClose={() => setImporting(false)}
          onDone={(result) => {
            setImporting(false);
            setGroup(null);
            setManager(null);
            setMessage(`战客清单已导入：${result.rowCount} 个集团。${result.backupError ? `注意：替换前的自动备份没有成功（${result.backupError}），请到“设置”查看。` : ''}`);
            refresh();
          }}
        />
      )}
      {failure && <Notice error>{failure}<button onClick={refresh}><RefreshCw size={14} />重试</button></Notice>}

      {loading && !overview.data ? <Loader /> : group ? (detail.data ? <GroupDetail data={detail.data} onOpenLine={onOpenLine} /> : detail.loading ? <Loader /> : null) : !list ? (
        <section className="rev-empty">
          <FileSpreadsheet size={42} strokeWidth={1.3} />
          <h2>还没有战客清单</h2>
          <p>下载模板，填写集团编码、集团名称、客户经理后，点击顶部“导入 Excel”导入。</p>
          <button onClick={downloadTemplate}><Download size={16} />下载模板</button>
        </section>
      ) : overview.data && (
        <>
          <div className="rev-view-controls">
            <div className="rev-segment" role="group" aria-label="渗透视图">
              <button aria-pressed={view === 'managers' && manager === null} onClick={() => switchView('managers')}><UsersRound size={16} />客户经理</button>
              <button aria-pressed={view === 'groups' || manager !== null} onClick={() => switchView('groups')}><Building2 size={16} />集团</button>
            </div>
          </div>
          <div className="rev-manager-scope" role="status" aria-label="客户经理筛选范围">
            <span>{manager !== null ? `当前范围：${manager || '未填写客户经理'}` : onlyDefaults ? '当前范围：指定 18 位客户经理，其他客户经理的集团未显示' : '当前范围：全部客户经理'}</span>
            <div className="rev-scope-actions" role="group" aria-label="客户经理快捷筛选">
              <button aria-pressed={manager === null && !onlyDefaults} onClick={() => { setOnlyDefaults(false); setManager(null); }}><UsersRound size={15} />查看全部客户经理</button>
              <button aria-pressed={manager === null && onlyDefaults} onClick={() => { setOnlyDefaults(true); setManager(null); }}><ListChecks size={15} />指定18位客户经理</button>
            </div>
          </div>

          <section className="rev-metrics" aria-label="渗透概览">
            <Metric label="战客集团" value={totals.total} note={manager !== null ? `${manager || '未填写客户经理'}名下` : onlyDefaults ? '指定 18 位客户经理名下' : '清单中全部集团'} />
            <Metric label="已渗透" value={totals.penetrated} className="rev-positive" note={`渗透率 ${percent(totals.penetrationRate)}`} />
            <Metric label="已流失" value={totals.lost} className={totals.lost > 0 ? 'rev-negative' : ''} note="曾有专线，现已全部销户" />
            <Metric label="未渗透" value={totals.untouched} note={`从未有过专线 · 含已流失共 ${totals.notPenetrated}`} />
          </section>

          {showingManagers ? (
            <section className="rev-section">
              <div className="rev-section-heading">
                <h3>客户经理战客渗透率 <span>{managers.length}</span></h3>
                <span className="rev-caption">渗透率 = 已渗透 ÷ 战客集团 · 点击客户经理查看其集团</span>
              </div>
              <DataTable rows={managers} rowKey="name" initialSort="penetrationRate" columns={[
                { key: 'name', label: '客户经理', render: (row) => <button className="rev-link" onClick={() => openManager(row.name)}>{row.name || '未填写'}</button> },
                { key: 'total', label: '战客集团', numeric: true },
                { key: 'penetrated', label: '已渗透', numeric: true },
                { key: 'penetrationRate', label: '渗透率', numeric: true, render: (row) => percent(row.penetrationRate) },
                { key: 'lost', label: '已流失', numeric: true, render: (row) => <span className={row.lost > 0 ? 'rev-negative' : ''}>{row.lost}</span> },
                { key: 'untouched', label: '未渗透', numeric: true },
                { key: 'notPenetrated', label: '未渗透+已流失', numeric: true },
                { key: 'activeLines', label: '在网专线', numeric: true },
                { key: 'activeMonthlyFee', label: '在网月资费', numeric: true, render: (row) => money(row.activeMonthlyFee) }
              ]} empty="没有客户经理" />
            </section>
          ) : (
            <section className="rev-section">
              <div className="rev-section-heading">
                <h3>{`${manager !== null ? `${manager || '未填写客户经理'} · ` : ''}${status === 'all' ? '全部战客集团' : `${filterByKey[status].label}战客集团`}`} <span>{rows.length}</span></h3>
                <span className="rev-caption">点击集团查看其专线</span>
              </div>
              <div className="rev-group-filters">
                <label className="rev-search"><Search size={16} /><input aria-label="搜索集团" placeholder="集团名称、集团编码或客户经理" value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label>
                <select aria-label="渗透状态筛选" value={status} onChange={(event) => setStatus(event.target.value)}>
                  {statusFilters.map((item) => <option key={item.key} value={item.key}>{item.label} {item.key === 'all' ? totals.total : totals[item.key]}</option>)}
                </select>
              </div>
              <DataTable key={status} rows={rows} rowKey="groupCode" initialSort={{ lost: 'lastCancelledAt', untouched: 'groupName', notPenetrated: 'cancelledLines' }[status] || 'activeMonthlyFee'} columns={[
                { key: 'groupName', label: '集团', render: (row) => <button className="rev-link rev-cell-stack rev-group-name" onClick={() => setGroup(row.groupCode)}><strong>{row.groupName || '未填写集团名称'}</strong><small>{row.groupCode}</small></button> },
                { key: 'managerName', label: '客户经理' },
                { key: 'status', label: '渗透状态', render: (row) => <span className={statusTone[row.status]}>{statusLabel[row.status]}</span> },
                { key: 'activeLines', label: '在网专线', numeric: true },
                { key: 'cancelledLines', label: '已销户专线', numeric: true },
                { key: 'activeMonthlyFee', label: '在网月资费', numeric: true, render: (row) => money(row.activeMonthlyFee) },
                { key: 'firstStartAt', label: '最早在网开通', render: (row) => day(row.firstStartAt) },
                { key: 'lastCancelledAt', label: '最近销户', render: (row) => day(row.lastCancelledAt) }
              ]} empty={keyword ? '没有符合搜索的集团' : '这一类没有集团'} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
