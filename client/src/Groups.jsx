import React, { useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, FileSpreadsheet, RefreshCw, Search, Upload, X } from 'lucide-react';
import { apiBase, isAbort, jsonBody, requestJson } from './api.js';
import { DataTable, Loader, Metric, Notice } from './GroupRevenue.jsx';
import { GroupedBars } from './charts.jsx';
import { confidenceName } from './kpiRows.js';
import Prospects from './Prospects.jsx';
import { changeFieldLabels, changeTypeLabel } from './ledgerChanges.js';
import { beijingTime, money } from './utils.js';
import './operations.css';

const lineFilters = [
  { key: '', label: '全部专线情况' },
  { key: 'active', label: '有在用专线' },
  { key: 'inactive', label: '台账中有记录，无在用专线' },
  { key: 'none', label: '未开通专线' }
];
const markFilters = [
  { key: '', label: '全部标记' },
  { key: 'strategic', label: '战客' },
  { key: 'key', label: '要客' },
  { key: 'mismatch', label: '客户经理与台账不一致' },
  { key: 'unlisted', label: '未在全量清单中' }
];
const levels = ['A', 'B', 'C', 'D'];
const lineKinds = { active: '在用', cancelled: '已销户', other: '未开通或回退' };
const kindRanks = { active: 3, cancelled: 2, other: 1 };
const strategicStatus = { penetrated: '已渗透', lost: '已流失', untouched: '未渗透' };
const warningLevels = { cancel: '待销户', red: '红色', yellow: '黄色', green: '绿色' };
const day = (value) => (value ? String(value).slice(0, 10) : '—');
const count = (value) => (value == null ? '—' : Number(value).toLocaleString('zh-CN'));
const dataMonth = (value) => (/^\d{6}$/.test(value || '') ? `${value.slice(0, 4)}年${Number(value.slice(4))}月` : value || '');
const revenue = (value) => (value == null ? '—' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function useResource(path, revision) {
  const [state, setState] = useState({ loading: Boolean(path), data: null, error: '' });
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

/** The small marks beside a group's name: key-customer category, strategic, and not on the list. */
export function GroupBadges({ group }) {
  return (
    <>
      {group.keyCategory && <span className={`group-badge ${group.keyCategory.includes('139') ? 'group-badge-key139' : 'group-badge-key'}`}>{group.keyCategory}</span>}
      {group.strategic && <span className="group-badge group-badge-strategic">战客</span>}
      {!group.listed && <span className="group-badge group-badge-muted" title="台账里有这个集团的专线，但全量集团清单中没有它">未在清单</span>}
    </>
  );
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
      setPreview(await requestJson('/groups/preview', { method: 'POST', body: form }));
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
      onDone(await requestJson('/groups/commit', jsonBody('POST', { token: preview.token })));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rev-import-panel" aria-label="全量集团清单导入">
      <div className="rev-section-heading">
        <h3>导入全量集团清单</h3>
        <button title="关闭导入" aria-label="关闭导入" onClick={onClose} disabled={busy}><X size={16} /></button>
      </div>
      <div className="rev-import-file">
        <FileSpreadsheet size={28} />
        <div>
          <strong>{preview?.fileName || '全量集团清单'}</strong>
          <small>Excel · 最多 32 MB · 读取含“集团编码、集团名称、集团客户经理名称”的工作表；带“客户类别”列的工作表作为要客清单</small>
        </div>
        <label className="rev-upload">{busy ? '处理中…' : '选择文件'}<input type="file" accept=".xlsx,.xls" onChange={choose} disabled={busy} /></label>
      </div>
      {error && <Notice error>{error}</Notice>}
      {preview && (
        <>
          <dl className="strategic-preview">
            <dt>集团</dt><dd>{count(preview.rowCount)} 个（工作表“{preview.sheetName}”{preview.dataMonth ? `，数据月份 ${dataMonth(preview.dataMonth)}` : ''}）</dd>
            <dt>与现有清单相比</dt><dd>{preview.replacing ? `新增 ${count(preview.added)} 个，移出 ${count(preview.removed)} 个，客户经理变更 ${count(preview.managerChanged)} 个` : '首次导入'}</dd>
            <dt>台账中有专线</dt><dd>{count(preview.inLedger)} 个，其中 {count(preview.ledgerMismatch)} 个的客户经理与台账不一致（以台账为准）</dd>
            <dt>台账有、清单没有</dt><dd>{count(preview.ledgerUnlisted)} 个集团，仍会显示并标“未在清单”</dd>
            <dt>战客标识</dt><dd>{count(preview.strategic)} 个（未单独导入战客清单时，战客专线渗透使用这些集团）</dd>
            <dt>要客清单</dt><dd>{preview.keySheets.length ? `工作表“${preview.keySheets.join('”“')}”：${count(preview.keyMatched)} 个集团标记了客户类别${preview.keyUnmatched ? `，另有 ${count(preview.keyUnmatched)} 个不在全量清单中，未标记` : ''}` : '文件中没有带“客户类别”列的工作表'}</dd>
            {preview.ignoredSheets.length > 0 && <><dt>未读取的工作表</dt><dd>{preview.ignoredSheets.join('、')}</dd></>}
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
            <button className="primary" disabled={busy} onClick={commit}><Upload size={16} />{busy ? '正在导入…' : preview.replacing ? '确认替换全量集团清单' : '确认导入'}</button>
            {preview.replacing && <span>整份替换：不在新清单里的集团会从清单中移出，客户经理按新清单更新。</span>}
          </div>
        </>
      )}
    </section>
  );
}

function RevenueTrend({ code, revision }) {
  const state = useResource(`/revenue/groups/${encodeURIComponent(code)}`, revision);
  const rows = (state.data?.trend || []).filter((row) => row.totalRevenue != null || row.lineRevenue != null);
  return (
    <section className="rev-section">
      <div className="rev-section-heading"><h3>收入</h3><span className="rev-caption">来自已导入的集团收入报表，税后</span></div>
      {state.loading ? <Loader /> : rows.length ? (
        <GroupedBars
          label="月度集团收入与专线收入"
          series={[{ key: 'total', label: '集团收入' }, { key: 'line', label: '专线收入' }]}
          format={revenue}
          rows={rows.map((row) => ({ key: row.month, label: row.month, sublabel: row.managerName, values: { total: row.totalRevenue, line: row.lineRevenue } }))}
        />
      ) : <p className="group-empty">{state.error || '已导入的收入报表中没有这个集团'}</p>}
    </section>
  );
}

function Profile({ data, code, revision, onOpenLine }) {
  const { group, lines, warnings, changes, forecasts, statuses, products } = data;
  const [showMore, setShowMore] = useState(false);
  const rankedLines = useMemo(() => lines.map((line) => ({ ...line, kindRank: kindRanks[line.kind] })), [lines]);
  const more = group.more;
  return (
    <>
      <div className="rev-group-heading">
        <div>
          <span className="rev-eyebrow">{group.groupCode}</span>
          <h2 className="group-title">{group.groupName || '未填写集团名称'}<GroupBadges group={group} /></h2>
          <p>
            客户经理 {group.managerName || '未知'}
            {group.managerMismatch && <span className="group-note">（以台账为准；全量清单登记为 {group.directoryManager}）</span>}
            {group.level && <> · 集团级别 {group.level}</>}
            {group.segment && <> · {group.segment}</>}
          </p>
        </div>
        {group.strategicStatus && <span className={`rev-label strategic-status-${group.strategicStatus}`}>战客 · {strategicStatus[group.strategicStatus]}</span>}
      </div>

      <section className="rev-metrics" aria-label="集团概览">
        <Metric label="在用专线" value={group.activeLines} note="正常在用、停机执行中、停机" />
        <Metric label="已销户专线" value={group.cancelledLines} />
        <Metric label="在用月资费" value={money(group.activeMonthlyFee)} note="实际月资费优先，否则活动套餐资费" />
        <Metric label="总欠费" value={money(group.totalArrears)} className={group.totalArrears > 0 ? 'rev-negative' : ''} />
      </section>

      {more && (
        <section className="group-more">
          <button type="button" className="text-button" aria-expanded={showMore} onClick={() => setShowMore((value) => !value)}>
            {showMore ? '收起更多信息' : '显示更多信息'}
          </button>
          {showMore && (
            <dl className="strategic-preview">
              <dt>微网格</dt><dd>{more.microGrid || '—'}</dd>
              <dt>入网时间</dt><dd>{day(more.joinedAt)}</dd>
              <dt>成员到达数</dt><dd>{count(more.memberCount)}</dd>
              <dt>企业员工数</dt><dd>{count(more.employeeCount)}</dd>
              <dt>移动成员数</dt><dd>{count(more.mobileMemberCount)}</dd>
              <dt>成员出账金额</dt><dd>{more.memberBilling == null ? '—' : money(more.memberBilling)}</dd>
              <dt>数据月份</dt><dd>{dataMonth(group.dataMonth) || '—'}（来自全量集团清单）</dd>
            </dl>
          )}
        </section>
      )}

      <section className="rev-section">
        <div className="rev-section-heading"><h3>专线 <span>{lines.length}</span></h3><span className="rev-caption">点击集团产品编码查看专线详情</span></div>
        {lines.length ? (
          <>
            <div className="group-tallies">
              <p><span>状态</span>{statuses.map((item) => <span key={item.name} className="group-tally">{item.name} <strong>{item.count}</strong></span>)}</p>
              {products.length > 0 && <p><span>在用产品</span>{products.map((item) => <span key={item.name} className="group-tally">{item.name} <strong>{item.count}</strong></span>)}</p>}
            </div>
            <DataTable rows={rankedLines} rowKey="id" initialSort="kindRank" columns={[
              { key: 'group_product_code', label: '集团产品编码', render: (row) => <button className="rev-link" onClick={() => onOpenLine(row.id)}>{row.group_product_code || `记录 ${row.id}`}</button> },
              { key: 'kindRank', label: '类别', render: (row) => <span className={row.kind === 'active' ? 'rev-positive' : row.kind === 'cancelled' ? 'rev-negative' : ''}>{lineKinds[row.kind]}</span> },
              { key: 'group_user_name', label: '专线名称' },
              { key: 'product_name', label: '产品名称' },
              { key: 'status', label: '状态' },
              { key: 'manager_name', label: '客户经理' },
              { key: 'start_time', label: '开始时间', render: (row) => day(row.start_time) },
              { key: 'status_time', label: '状态时间', render: (row) => day(row.status_time) },
              { key: 'monthly_fee', label: '月资费', numeric: true, render: (row) => money(row.monthly_fee) },
              { key: 'total_arrears', label: '欠费', numeric: true, render: (row) => <span className={row.total_arrears > 0 ? 'rev-negative' : ''}>{money(row.total_arrears)}</span> }
            ]} />
          </>
        ) : <p className="group-empty">{group.inLedger ? '当前台账范围内没有这个集团的专线（可关闭 KPI统计模式 查看全部产品）' : '尚未开通专线：台账中没有这个集团的专线'}</p>}
      </section>

      <section className="rev-section">
        <div className="rev-section-heading"><h3>欠费销户风险 <span>{warnings.length}</span></h3><span className="rev-caption">停机且有欠费的专线，截至 {data.warningsAsOf}</span></div>
        {warnings.length ? (
          <DataTable rows={warnings} rowKey="id" initialSort="stopped_days" columns={[
            { key: 'group_product_code', label: '集团产品编码', render: (row) => <button className="rev-link" onClick={() => onOpenLine(row.id)}>{row.group_product_code || `记录 ${row.id}`}</button> },
            { key: 'product_name', label: '产品名称' },
            { key: 'stopped_days', label: '停机时长', numeric: true, render: (row) => <span className={`operations-duration operations-level-${row.warning_level}`}>{row.stopped_days} 天</span> },
            { key: 'warning_level', label: '预警等级', sortable: false, render: (row) => <span className={`operations-risk operations-level-${row.warning_level}`}>{warningLevels[row.warning_level]}</span> },
            { key: 'status_time', label: '停机时间', render: (row) => day(row.status_time) },
            { key: 'total_arrears', label: '总欠费', numeric: true, render: (row) => money(row.total_arrears) }
          ]} />
        ) : <p className="group-empty">没有停机且欠费的专线</p>}
      </section>

      <RevenueTrend code={code} revision={revision} />

      <section className="rev-section">
        <div className="rev-section-heading"><h3>KPI 预计任务 <span>{forecasts.length}</span></h3></div>
        {forecasts.length ? (
          <DataTable rows={forecasts} rowKey="id" initialSort="id" columns={[
            { key: 'id', label: '月份', render: (row) => `${row.year}年${row.month}月` },
            { key: 'kind', label: '类别', render: (row) => <span className={row.kind === 'cancelled' ? 'rev-negative' : 'rev-positive'}>{row.kind === 'cancelled' ? '预计销户' : '预计新增'}</span> },
            { key: 'confidence', label: '把握度', sortable: false, render: (row) => confidenceName(row.kind, row.confidence) },
            { key: 'product_type', label: '产品类型' },
            { key: 'line_count', label: '条数', numeric: true },
            { key: 'landed_count', label: '已落地', numeric: true },
            { key: 'latest_note', label: '最新进展', sortable: false, render: (row) => (row.latest_note ? <span className="group-wrap" title={row.latest_note}>{row.latest_note}<small>{beijingTime(row.latest_at)}</small></span> : '—') }
          ]} />
        ) : <p className="group-empty">没有登记这个集团的预计任务</p>}
      </section>

      <section className="rev-section">
        <div className="rev-section-heading"><h3>最近导入变化 <span>{changes.length}</span></h3><span className="rev-caption">各次台账导入中这个集团专线的变化，最多显示 30 条</span></div>
        {changes.length ? (
          <DataTable rows={changes} rowKey="id" initialSort="id" columns={[
            { key: 'id', label: '时间', render: (row) => beijingTime(row.created_at) },
            { key: 'change_type', label: '变化', render: (row) => changeTypeLabel(row.change_type) },
            { key: 'group_product_code', label: '集团产品编码', render: (row) => (row.line_id ? <button className="rev-link" onClick={() => onOpenLine(row.line_id)}>{row.group_product_code || `记录 ${row.line_id}`}</button> : row.group_product_code || '—') },
            { key: 'field_name', label: '内容', sortable: false, render: (row) => (row.field_name
              ? <span className="group-wrap">{changeFieldLabels[row.field_name] || row.field_name}：{row.old_value || '—'} → {row.new_value || '—'}</span>
              : row.note || '—') }
          ]} />
        ) : <p className="group-empty">最近的导入没有改动这个集团的专线</p>}
      </section>
    </>
  );
}

/**
 * 集团: every group on the full group list together with every group the ledger has lines for,
 * and one page per group that gathers its lines, arrears risk, revenue, forecasts and changes.
 */
export default function Groups({ ref, kpiMode, refreshToken, onOpenLine, focus, onForecast }) {
  const [revision, setRevision] = useState(0);
  // 全部集团, or the prospect list: groups with no line in service.
  const [tab, setTab] = useState('all');
  const [prospectQuery, setProspectQuery] = useState('');
  const [code, setCode] = useState(null);
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState('');
  const [mark, setMark] = useState('');
  const [level, setLevel] = useState('');
  const [page, setPage] = useState(1);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState('');
  const refresh = () => setRevision((value) => value + 1);

  // Another page opens one group's profile; a click on the menu comes back to the list.
  useEffect(() => {
    if (focus) setCode(focus.groupCode ?? null);
  }, [focus]);

  // Typing searches after a short pause, so each keystroke does not ask the server.
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(typed.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const filterQuery = new URLSearchParams({ kpiMode: kpiMode ? '1' : '0', ...(search && { search }), ...(lines && { lines }), ...(mark && { mark }), ...(level && { level }) }).toString();
  const stamp = `${revision}:${refreshToken}`;
  const list = useResource(code || tab !== 'all' ? null : `/groups?${filterQuery}&page=${page}`, stamp);
  const profile = useResource(code ? `/groups/${encodeURIComponent(code)}?kpiMode=${kpiMode ? '1' : '0'}` : null, stamp);

  useImperativeHandle(ref, () => ({
    refresh,
    openImport: () => { setCode(null); setTab('all'); setImporting(true); },
    exportData: () => {
      window.location.href = tab === 'prospects' && !code && prospectQuery
        ? `${apiBase}/groups/prospects/export?${prospectQuery}`
        : `${apiBase}/groups/export?${filterQuery}`;
    }
  }), [filterQuery, tab, code, prospectQuery]);

  const data = list.data;
  const imported = data?.list;
  const summary = data?.summary;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const pick = (setter) => (event) => { setter(event.target.value); setPage(1); };
  const failure = code ? profile.error : tab === 'all' ? list.error : '';

  return (
    <main className="revenue-page groups-page">
      <div className="rev-toolbar">
        <div className="rev-breadcrumbs">
          <button onClick={() => setCode(null)}>集团</button>
          {code && <><ChevronRight size={14} /><span>集团档案</span></>}
        </div>
        {!code && (
          <div className="rev-segment" role="group" aria-label="集团视图">
            <button aria-pressed={tab === 'all'} onClick={() => setTab('all')}>全部集团</button>
            <button aria-pressed={tab === 'prospects'} onClick={() => { setTab('prospects'); setImporting(false); }}>潜客清单</button>
          </div>
        )}
      </div>
      {!code && tab === 'prospects' && (
        <div className="rev-context">
          <span>潜客 = 没有在用专线的集团：未开通（台账中没有专线）和已流失（曾有专线，现已全部销户）</span>
          <span>台账范围：{kpiMode ? 'KPI 十类产品' : '全部产品'} · 跟进标记按集团编码保存，重新导入全量清单后保留</span>
        </div>
      )}
      {!code && tab === 'all' && (
        <div className="rev-context">
          <span>{imported
            ? `全量集团清单：${imported.file_name || '未命名'} · ${count(imported.row_count)} 个集团${imported.data_month ? ` · 数据月份 ${dataMonth(imported.data_month)}` : ''} · ${beijingTime(imported.imported_at)} 导入`
            : '还没有导入全量集团清单，当前只有台账中的集团。点击顶部“导入 Excel”导入。'}</span>
          <span>台账范围：{kpiMode ? 'KPI 十类产品' : '全部产品'} · 客户经理以台账为准，台账没有专线的集团用清单中的客户经理</span>
        </div>
      )}
      {message && <div className="rev-success" role="status">{message}<button title="关闭提示" aria-label="关闭提示" onClick={() => setMessage('')}><X size={14} /></button></div>}
      {importing && !code && (
        <ImportPanel
          onClose={() => setImporting(false)}
          onDone={(result) => {
            setImporting(false);
            setPage(1);
            setMessage(`全量集团清单已导入：${count(result.rowCount)} 个集团。${result.backupError ? `注意：替换前的自动备份没有成功（${result.backupError}），请到“设置”查看。` : ''}`);
            refresh();
          }}
        />
      )}
      {failure && <Notice error>{failure}<button onClick={refresh}><RefreshCw size={14} />重试</button></Notice>}

      {code ? (
        profile.data ? <Profile data={profile.data} code={code} revision={stamp} onOpenLine={onOpenLine} /> : profile.loading ? <Loader /> : null
      ) : tab === 'prospects' ? (
        <Prospects
          kpiMode={kpiMode}
          stamp={stamp}
          Badges={GroupBadges}
          onQuery={setProspectQuery}
          onOpenGroup={(groupCode) => { setCode(groupCode); window.scrollTo(0, 0); }}
          onForecast={onForecast}
        />
      ) : !data ? (list.loading ? <Loader /> : null) : (
        <>
          <section className="rev-metrics" aria-label="集团概览">
            <Metric label="集团" value={count(summary.total)} note={`全量清单 ${count(summary.listed)} 个${summary.unlisted ? ` · 清单外 ${count(summary.unlisted)} 个` : ''}`} />
            <Metric label="有在用专线" value={count(summary.withActive)} className="rev-positive" />
            <Metric label="无在用专线" value={count(summary.inactive)} note="台账中有记录，现无在用" />
            <Metric label="未开通专线" value={count(summary.noLines)} note="台账中没有专线" />
          </section>
          {(summary.mismatch > 0 || summary.unlisted > 0) && (
            <p className="group-hints">
              {summary.mismatch > 0 && <button type="button" className="text-button" onClick={() => { setMark('mismatch'); setPage(1); }}>{count(summary.mismatch)} 个集团的客户经理与台账不一致（已按台账显示）</button>}
              {summary.unlisted > 0 && <button type="button" className="text-button" onClick={() => { setMark('unlisted'); setPage(1); }}>{count(summary.unlisted)} 个台账中的集团不在全量清单中</button>}
            </p>
          )}

          <section className="rev-section">
            <div className="rev-section-heading">
              <h3>集团 <span>{count(data.total)}</span></h3>
              <span className="rev-caption">点击集团查看档案 · 有在用专线的排在前面</span>
            </div>
            <div className="rev-group-filters group-filters">
              <label className="rev-search"><Search size={16} /><input aria-label="搜索集团" placeholder="集团名称、集团编码或客户经理" value={typed} onChange={(event) => setTyped(event.target.value)} /></label>
              <select aria-label="专线情况" value={lines} onChange={pick(setLines)}>{lineFilters.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select>
              <select aria-label="标记" value={mark} onChange={pick(setMark)}>{markFilters.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select>
              <select aria-label="集团级别" value={level} onChange={pick(setLevel)}><option value="">全部级别</option>{levels.map((item) => <option key={item} value={item}>{item} 级</option>)}</select>
            </div>
            <div className={`rev-table-scroll${list.loading ? ' group-loading' : ''}`} tabIndex={0} role="region" aria-label="集团列表">
              <table className="rev-table">
                <thead><tr><th>集团</th><th>客户经理</th><th>级别</th><th className="rev-number">在用专线</th><th className="rev-number">已销户专线</th><th className="rev-number">台账专线合计</th></tr></thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.groupCode}>
                      <td>
                        <button className="rev-link rev-cell-stack rev-group-name" onClick={() => { setCode(row.groupCode); window.scrollTo(0, 0); }}>
                          <strong>{row.groupName || '未填写集团名称'}</strong>
                          <small>{row.groupCode}</small>
                        </button>
                        <span className="group-badges"><GroupBadges group={row} /></span>
                      </td>
                      <td>{row.managerName || '—'}{row.managerMismatch && <small className="group-sub">清单：{row.directoryManager}</small>}</td>
                      <td>{row.level || '—'}</td>
                      <td className="rev-number">{row.activeLines}</td>
                      <td className="rev-number">{row.cancelledLines}</td>
                      <td className="rev-number">{row.totalLines}</td>
                    </tr>
                  ))}
                  {!data.rows.length && <tr><td colSpan="6" className="rev-empty-cell">{search || lines || mark || level ? '没有符合条件的集团' : '还没有集团'}</td></tr>}
                </tbody>
              </table>
            </div>
            {data.total > data.pageSize && (
              <div className="rev-pager">
                <span>共 {count(data.total)} 个</span>
                <button title="上一页" aria-label="上一页" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button>
                <span>{page} / {count(pages)}</span>
                <button title="下一页" aria-label="下一页" disabled={page >= pages} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
