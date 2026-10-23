import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Building2, ChevronLeft, ChevronRight, FileSpreadsheet, History, ListChecks, Plus, RefreshCw, Save, Search, Settings2, Trash2, Upload, UsersRound, X, Pencil, CircleAlert } from 'lucide-react';
import './revenue.css';

const format = (value) => value == null ? '—' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percent = (value) => value == null ? '—' : `${(value * 100).toFixed(2)}%`;
const signed = (value) => value == null ? '—' : `${value > 0 ? '+' : ''}${format(value)}`;
const tone = (value) => value > 0 ? 'rev-positive' : value < 0 ? 'rev-negative' : '';
const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';

async function request(path, options = {}) {
  const response = await fetch(`/api/revenue${path}`, options);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('接口返回异常，请确认服务已更新并重新启动'); }
  if (!response.ok) throw new Error(response.status === 401 ? '登录已过期，请重新登录' : data.error || '请求失败');
  return data;
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function useResource(path, revision) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  useEffect(() => {
    if (path == null) { setState({ loading: false, data: null, error: '' }); return; }
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));
    request(path, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setState({ loading: false, data, error: '' });
    }).catch((error) => {
      if (!controller.signal.aborted) setState({ loading: false, data: null, error: error.message });
    });
    return () => controller.abort();
  }, [path, revision]);
  return state;
}

function Notice({ children, error = false }) {
  return <div className={`rev-notice${error ? ' rev-error' : ''}`} role={error ? 'alert' : 'status'}><CircleAlert size={17} /><div>{children}</div></div>;
}
function Loader() {
  return <div className="rev-skeleton" role="status" aria-label="正在加载收入数据"><div /><div /><div /><div /><span className="rev-sr-only">加载中</span></div>;
}
function Metric({ label, value, note, className = '' }) {
  return <div className={`rev-metric ${className}`}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}
function Metrics({ data }) {
  return <section className="rev-metrics" aria-label="收入概览">
    <Metric label="集团信息化收入" value={format(data.totalRevenue)} note={`报表 ${format(data.reportRevenue ?? data.totalRevenue)} · 补录 ${format(data.supplementRevenue ?? 0)}`} />
    <Metric label="报表专线收入" value={format(data.lineRevenue)} note="报表专线分类" />
    <Metric label="专线收入占比" value={percent(data.lineShare ?? (data.totalRevenue > 0 ? data.lineRevenue / data.totalRevenue : null))} note="集团全部产品收入为分母" />
    <Metric label="较上月变化" value={signed(data.change)} className={tone(data.change)} note={data.previousRevenue == null ? '上月无可比较记录' : `上月 ${format(data.previousRevenue)} · ${data.previousRevenue <= 0 ? '非正基期' : percent(data.changeRate)}`} />
  </section>;
}

function DataTable({ rows, columns, rowKey, initialSort, empty = '暂无记录', pageSize = 30 }) {
  const [sort, setSort] = useState({ key: initialSort || columns[0].key, direction: 'desc' });
  const [page, setPage] = useState(1);
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const left = a[sort.key], right = b[sort.key];
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    const comparison = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), 'zh-CN');
    return sort.direction === 'asc' ? comparison : -comparison;
  }), [rows, sort]);
  useEffect(() => setPage(1), [rows, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pages);
  return <>
    <div className="rev-table-scroll" tabIndex={0} role="region" aria-label="收入数据表">
      <table className="rev-table"><thead><tr>{columns.map((column) => <th key={column.key} className={column.numeric ? 'rev-number' : ''} aria-sort={sort.key === column.key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
        {column.sortable === false ? column.label : <button type="button" onClick={() => setSort({ key: column.key, direction: sort.key === column.key && sort.direction === 'desc' ? 'asc' : 'desc' })}>
          {column.label}{sort.key === column.key ? sort.direction === 'desc' ? <ArrowDown size={12} /> : <ArrowUp size={12} /> : <ArrowUpDown size={12} />}
        </button>}
      </th>)}</tr></thead><tbody>{sorted.slice((current - 1) * pageSize, current * pageSize).map((row, index) => <tr key={typeof rowKey === 'function' ? rowKey(row) : row[rowKey] ?? index}>
        {columns.map((column) => <td key={column.key} className={column.numeric ? 'rev-number' : ''}>{column.render ? column.render(row) : row[column.key] ?? '—'}</td>)}
      </tr>)}{!sorted.length && <tr><td colSpan={columns.length} className="rev-empty-cell">{empty}</td></tr>}</tbody></table>
    </div>
    {sorted.length > pageSize && <div className="rev-pager"><span>共 {sorted.length} 项</span><button title="上一页" aria-label="上一页" disabled={current === 1} onClick={() => setPage(current - 1)}><ChevronLeft size={16} /></button><span>{current} / {pages}</span><button title="下一页" aria-label="下一页" disabled={current === pages} onClick={() => setPage(current + 1)}><ChevronRight size={16} /></button></div>}
  </>;
}

function Trend({ rows }) {
  const maximum = Math.max(1, ...rows.flatMap((row) => [Math.abs(row.totalRevenue ?? 0), Math.abs(row.lineRevenue ?? 0)]));
  return <section className="rev-trend" aria-label="月度收入趋势">
    <div className="rev-section-heading"><h3>收入趋势</h3><div className="rev-legend"><span><i className="rev-total-dot" />集团收入</span><span><i className="rev-line-dot" />专线收入</span></div></div>
    <div className="rev-trend-grid">{rows.map((row) => <div className="rev-trend-month" key={row.month}>
      <span>{row.month}{row.managerName && <small>{row.managerName}</small>}</span>
      <div className="rev-trend-bars"><div title={`集团收入 ${format(row.totalRevenue)}`} style={{ width: `${Math.max(0, Math.abs(row.totalRevenue ?? 0) / maximum * 100)}%` }} className={`rev-total-bar ${row.totalRevenue < 0 ? 'rev-negative-bar' : ''}`} />
        <div title={`专线收入 ${format(row.lineRevenue)}`} style={{ width: `${Math.max(0, Math.abs(row.lineRevenue ?? 0) / maximum * 100)}%` }} className={`rev-line-bar ${row.lineRevenue < 0 ? 'rev-negative-bar' : ''}`} /></div>
      <div className="rev-trend-values"><strong>{format(row.totalRevenue)}</strong><span>{format(row.lineRevenue)}</span></div>
    </div>)}</div>
  </section>;
}

function ManagerPicker({ options, selected, onChange }) {
  const [search, setSearch] = useState('');
  const count = options.filter((item) => selected.includes(item.id)).length;
  return <details className="rev-picker"><summary><UsersRound size={16} />{selected.length ? count ? `客户经理 · ${count}` : '默认名单无匹配' : '全部客户经理'}</summary><div className="rev-picker-menu">
    <div className="rev-picker-tools"><input aria-label="搜索客户经理" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="姓名或工号" /><button onClick={() => onChange([])}>查看全部</button></div>
    <div className="rev-picker-options">{options.filter((item) => `${item.name} ${item.id}`.includes(search)).map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => onChange(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} /><span>{item.name || '未填写'}<small>{item.id || '无工号'}</small></span></label>)}</div>
  </div></details>;
}

function ImportPanel({ onDone, onClose }) {
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function upload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(''); setPreview(null);
    const form = new FormData(); form.append('file', file);
    try { setPreview(await request('/imports/preview', { method: 'POST', body: form })); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); event.target.value = ''; }
  }
  async function commit() {
    setBusy(true); setError('');
    try { const result = await request(`/imports/${preview.id}/commit`, json('POST', { replace: true })); onDone(result); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <section className="rev-import-panel" aria-label="收入报表导入">
    <div className="rev-section-heading"><h3>导入收入报表</h3><button title="关闭导入" aria-label="关闭导入" onClick={onClose} disabled={busy}><X size={16} /></button></div>
    <div className="rev-import-file"><FileSpreadsheet size={28} /><div><strong>{preview?.fileName || 'BOSS 收入报表'}</strong><small>Excel · 最多 32 MB · 月份取报表内“月份”列</small></div><label className="rev-upload">{busy ? '处理中…' : '选择文件'}<input type="file" accept=".xlsx,.xls" onChange={upload} disabled={busy} /></label></div>
    {error && <Notice error>{error}</Notice>}
    {preview && <>
      <DataTable rows={preview.months} rowKey="month" columns={[
        { key: 'month', label: '收入月份' }, { key: 'rowCount', label: '明细行数', numeric: true }, { key: 'groupCount', label: '集团数', numeric: true },
        { key: 'totalRevenue', label: '集团收入', numeric: true, render: (row) => format(row.totalRevenue) },
        { key: 'previousRevenue', label: '现有报表集团收入', numeric: true, render: (row) => format(row.previousRevenue) },
        { key: 'previousRowCount', label: '现有明细行数', numeric: true },
        { key: 'ungroupedRevenue', label: '无集团收入', numeric: true, render: (row) => format(row.ungroupedRevenue) }
      ]} />
      <ul className="rev-notes">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      <div className="rev-actions"><button className="primary" disabled={busy || preview.duplicate} onClick={commit}><Upload size={16} />{busy ? '正在导入…' : preview.months.some((item) => item.previousRevenue != null) ? '确认替换该月报表' : '确认导入'}</button>{preview.duplicate && <span>已导入，不重复统计</span>}</div>
    </>}
  </section>;
}

function ServiceForm({ service, groupCode, month, rows, onSaved, onClose }) {
  const [form, setForm] = useState(() => ({ requestId: crypto.randomUUID(), groupCode, month, name: '专线延伸服务', grossAmount: '', coverage: 'pending', confirmed: false, frequency: 'once', endMonth: '', sourceRowId: '', remark: '', ...service }));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await request(service ? `/services/${service.id}` : '/services', json(service ? 'PUT' : 'POST', {
        ...form, sourceRowId: form.sourceRowId ? Number(form.sourceRowId) : null, confirmed: form.coverage === 'pending' ? false : form.confirmed,
        endMonth: form.frequency === 'monthly' ? form.endMonth || null : null
      })); onSaved();
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return <form className="rev-service-form" onSubmit={save} aria-label="延伸服务登记">
    <div className="rev-section-heading"><h3>{service ? '编辑延伸服务' : '登记延伸服务'}</h3><button type="button" title="关闭登记" aria-label="关闭登记" disabled={busy} onClick={onClose}><X size={16} /></button></div>
    <div className="rev-form-grid">
      <label>服务名称<input required maxLength={200} value={form.name} onChange={(event) => update('name', event.target.value)} /></label>
      <label>收入所属月<input type="month" required value={form.month} onChange={(event) => { update('month', event.target.value); update('sourceRowId', ''); }} /></label>
      <label>含税出账金额<input type="number" required step="0.01" value={form.grossAmount} onChange={(event) => update('grossAmount', event.target.value)} /></label>
      <div className="rev-form-output"><span>预计信息化收入 · 税率 6%</span><strong>{form.grossAmount === '' ? '—' : format(Number(form.grossAmount) / 1.06)}</strong></div>
      <label>报表是否已包含<select value={form.coverage} onChange={(event) => { update('coverage', event.target.value); update('confirmed', false); update('sourceRowId', ''); }}><option value="pending">待核验</option><option value="included">报表已包含</option><option value="excluded">报表未包含</option></select></label>
      <label>服务频次<select value={form.frequency} onChange={(event) => update('frequency', event.target.value)}><option value="once">单次</option><option value="monthly">按月</option></select></label>
      {form.frequency === 'monthly' && <label>有效截止月<input type="month" min={form.month} value={form.endMonth || ''} onChange={(event) => update('endMonth', event.target.value)} /></label>}
      {form.coverage !== 'excluded' && <label>关联报表源行<select value={form.sourceRowId || ''} onChange={(event) => update('sourceRowId', event.target.value)}><option value="">未关联</option>{form.month === month && rows.map((row) => <option key={row.id} value={row.id}>第 {row.rowNumber} 行 · {row.productName} · {format(row.revenue)}</option>)}</select></label>}
      <label className="rev-form-wide">备注及依据<textarea rows={2} maxLength={4000} value={form.remark} onChange={(event) => update('remark', event.target.value)} /></label>
    </div>
    <label className="rev-checkbox"><input type="checkbox" disabled={form.coverage === 'pending'} checked={form.confirmed} onChange={(event) => update('confirmed', event.target.checked)} />已核验本月报表覆盖情况及实际收入</label>
    <p className="rev-caption">{form.coverage === 'excluded' ? '确认后计入集团补录收入；报表专线收入保持原值。' : form.coverage === 'included' ? '登记用于收入核对，不重复增加集团实际收入。' : '待核验记录不计入实际收入合计。'}{form.frequency === 'monthly' && ' 后续月份仅作为待核对预计值。'}</p>
    {error && <Notice error>{error}</Notice>}
    <div className="rev-actions"><button type="submit" className="primary" disabled={busy}><Save size={16} />{busy ? '保存中…' : '保存登记'}</button><button type="button" disabled={busy} onClick={onClose}>取消</button></div>
  </form>;
}

function GroupDetail({ data, month, onOpenLine, onRefresh }) {
  const [editing, setEditing] = useState(null), [deleting, setDeleting] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { setEditing(null); setDeleting(null); setError(''); }, [month, data.group.groupCode]);
  async function remove() {
    setBusy(true); setError('');
    try { await request(`/services/${deleting.id}`, json('DELETE', { version: deleting.version })); setDeleting(null); onRefresh(); }
    catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  const reconciled = data.reconciliation;
  return <>
    <div className="rev-group-heading"><div><span className="rev-eyebrow">{data.group.groupCode}</span><h2>{data.group.groupName}</h2><p>{data.group.managerName || '本月无报表归属'} · {month}</p></div><span className="rev-label">当前在用台账 {data.group.currentLineCount} 条</span></div>
    {!data.group.hasReport && <Notice>该集团在本月没有报表记录，收入不按零计算。</Notice>}
    {data.group.managerChanged && <Notice>客户经理归属已从 {data.group.previousManagerName || '未填写'} 变更为 {data.group.managerName}。</Notice>}
    <Metrics data={data.group} /><Trend rows={data.trend} />
    <section className="rev-section"><div className="rev-section-heading"><h3>产品收入</h3><span className="rev-caption">信息化收入 · 原表金额单位</span></div>
      <DataTable rows={data.products} rowKey={(row) => JSON.stringify([row.productId, row.productName, row.category])} initialSort="revenue" columns={[
        { key: 'productName', label: '产品名称', render: (row) => <div className="rev-cell-stack"><strong>{row.productName || '未填写'}</strong><small>{row.productId}</small></div> }, { key: 'category', label: '收入分类' },
        { key: 'revenue', label: '本月收入', numeric: true, render: (row) => format(row.revenue) }, { key: 'previousRevenue', label: '上月收入', numeric: true, render: (row) => format(row.previousRevenue) },
        { key: 'change', label: '变化金额', numeric: true, render: (row) => <span className={tone(row.change)}>{signed(row.change)}</span> }, { key: 'changeRate', label: '环比', numeric: true, render: (row) => percent(row.changeRate) }
      ]} />
    </section>
    <section className="rev-section"><div className="rev-section-heading"><h3>收入核对</h3><span className="rev-label rev-warning">核对条件不足</span></div>
      <div className="rev-reconcile-grid"><Metric label="报表专线收入" value={format(reconciled.reportLineRevenue)} /><Metric label="台账预计含税出账" value={format(reconciled.grossEstimate)} /><Metric label="台账预计信息化收入" value={format(reconciled.netEstimate)} /><Metric label="已核验服务税后收入" value={format(reconciled.serviceNet)} /><Metric label="参考差额" value={format(reconciled.referenceDifference)} note="当前台账推算 · 非准确对账" /></div>
      <ul className="rev-notes">{reconciled.messages.map((message, index) => <li key={index}>{message}</li>)}</ul>
    </section>
    <section className="rev-section"><div className="rev-section-heading"><h3>专线延伸服务 <span>{data.services.length}</span></h3><button onClick={() => setEditing({})} disabled={!data.group.hasReport}><Plus size={16} />登记服务</button></div>
      {error && <Notice error>{error}</Notice>}
      {editing && <ServiceForm key={editing.id || 'new'} service={editing.id ? editing : null} groupCode={data.group.groupCode} month={month} rows={data.sourceRows} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onRefresh(); }} />}
      {deleting && <Notice><p>删除“{deleting.name}”的登记？已确认的补录收入将从合计中移除。</p><div className="rev-actions"><button className="rev-danger" disabled={busy} onClick={remove}>确认删除</button><button disabled={busy} onClick={() => setDeleting(null)}>取消</button></div></Notice>}
      <DataTable rows={data.services} rowKey="id" columns={[
        { key: 'name', label: '服务名称' }, { key: 'month', label: '登记月份' }, { key: 'grossAmount', label: '含税出账', numeric: true, render: (row) => format(row.grossAmount) },
        { key: 'revenue', label: '信息化收入 · 6%', numeric: true, render: (row) => format(row.revenue) },
        { key: 'coverage', label: '覆盖情况', render: (row) => ({ included: '报表已包含', excluded: '报表未包含', pending: '待核验' })[row.coverage] },
        { key: 'confirmed', label: '核验状态', render: (row) => <span className={row.needsReview ? 'rev-negative' : ''}>{row.projected ? '后续月份预计' : row.needsReview ? '报表修订，待复核' : row.confirmed ? '已核验' : '待核验'}</span> },
        { key: 'actions', label: '操作', sortable: false, render: (row) => <div className="rev-actions"><button title="编辑服务" aria-label={`编辑服务 ${row.name}`} onClick={() => setEditing(row)}><Pencil size={14} /></button><button title="删除服务" aria-label={`删除服务 ${row.name}`} onClick={() => setDeleting(row)}><Trash2 size={14} /></button></div> }
      ]} empty="本月暂无延伸服务登记" />
    </section>
    <section className="rev-section"><div className="rev-section-heading"><h3>关联专线</h3><span className="rev-caption">当前台账 · {data.lines.length} 条</span></div>
      <DataTable rows={data.lines} rowKey="id" columns={[
        { key: 'group_product_code', label: '集团产品编码', render: (row) => <button className="rev-link" onClick={() => onOpenLine(row)}>{row.group_product_code || `记录 ${row.id}`}</button> },
        { key: 'group_user_name', label: '专线名称' }, { key: 'product_name', label: '产品名称' }, { key: 'product_status_name', label: '状态' }, { key: 'bandwidth', label: '带宽' },
        { key: 'actual_monthly_fee', label: '实际月资费（含税）', numeric: true, render: (row) => format(row.actual_monthly_fee) },
        { key: 'package_fee', label: '活动套餐资费（含税）', numeric: true, render: (row) => format(row.package_fee) }, { key: 'contract_end_date', label: '合同结束' }
      ]} empty="当前筛选范围无关联台账" />
    </section>
    <details className="rev-source"><summary>报表源行 <span>{data.sourceRows.length} 行</span></summary><DataTable rows={data.sourceRows} rowKey="id" initialSort="rowNumber" columns={[
      { key: 'rowNumber', label: 'Excel 行号' }, { key: 'productName', label: '产品' }, { key: 'category', label: '分类' },
      ...[['gross', '出账金额'], ['tax', '税费'], ['adjustment', '调账金额'], ['adjustmentTax', '调账税费'], ['revenue', '信息化收入']].map(([key, label]) => ({ key, label, numeric: true, render: (row) => format(row[key]) }))
    ]} /></details>
    {data.audit?.length > 0 && <details className="rev-source"><summary>服务修改记录</summary><DataTable rows={data.audit} rowKey={(row) => `${row.entityId}-${row.createdAt}-${row.action}`} columns={[{ key: 'createdAt', label: '时间', render: (row) => date(row.createdAt) }, { key: 'actor', label: '操作人' }, { key: 'action', label: '操作', render: (row) => ({ create: '登记', update: '修改', delete: '删除', 'import-invalidate': '报表更新，确认失效' })[row.action] || row.action }]} /></details>}
  </>;
}

export default function GroupRevenue({ ref, onExportReady, kpiMode, defaultManagers, onOpenLine, refreshToken }) {
  const [revision, setRevision] = useState(0), [month, setMonth] = useState(''), [selected, setSelected] = useState(null);
  const [view, setView] = useState('managers'), [manager, setManager] = useState(null), [group, setGroup] = useState(null);
  const [keyword, setKeyword] = useState(''), [filter, setFilter] = useState('all'), [importing, setImporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false), [tolerance, setTolerance] = useState('0.01'), [settingBusy, setSettingBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const defaultsApplied = useRef(false);
  const refresh = () => setRevision((value) => value + 1);
  const meta = useResource('/meta', `${revision}:${refreshToken}`);
  const settings = useResource('/settings', `${revision}:${refreshToken}`);
  const managers = useMemo(() => [...new Map((meta.data?.managers || []).map((item) => [item.id, item])).values()], [meta.data]);
  const defaultManagerIds = useMemo(() => {
    const ids = managers.filter((item) => defaultManagers.includes(item.name)).map((item) => item.id);
    return ids.length ? ids : ['__default_managers_missing__'];
  }, [managers, defaultManagers]);
  useEffect(() => {
    if (!meta.data) return;
    if (!month && meta.data.months.length) setMonth(meta.data.months[0]);
    if (!defaultsApplied.current && managers.length) {
      setSelected(defaultManagerIds); defaultsApplied.current = true;
    }
  }, [meta.data, month, managers, defaultManagerIds]);
  useEffect(() => { if (settings.data) setTolerance(String(settings.data.tolerance)); }, [settings.data]);
  const params = new URLSearchParams({ month, kpiMode: kpiMode ? '1' : '0' });
  if (view === 'groups' && manager !== null) params.set('managers', manager);
  else if (selected?.length) params.set('managers', selected.join('|'));
  const summary = useResource(month && selected !== null && view !== 'history' && !group ? `/summary?${params}` : null, `${revision}:${refreshToken}`);
  const detail = useResource(group && month ? `/groups/${encodeURIComponent(group)}?month=${month}&kpiMode=${kpiMode ? '1' : '0'}` : null, `${revision}:${refreshToken}`);
  const data = summary.data;
  const scopedManagerIds = view === 'groups' && manager !== null ? [manager] : selected || [];
  const scopedManagers = managers.filter((item) => scopedManagerIds.includes(item.id));
  const groups = useMemo(() => (data?.groups || []).filter((row) => (manager === null || row.managerId === manager)
    && `${row.groupCode} ${row.groupName}`.includes(keyword.trim())
    && (filter !== 'decline' || row.change < 0) && (filter !== 'unmatched' || !row.matched)
    && (filter !== 'review' || row.needsReviewCount > 0)), [data, manager, keyword, filter]);
  async function saveSettings(event) {
    event.preventDefault(); setError(''); setSettingBusy(true);
    try { await request('/settings', json('PUT', { tolerance })); setSettingsOpen(false); refresh(); }
    catch (failure) { setError(failure.message); } finally { setSettingBusy(false); }
  }
  const revenueColumns = [
    { key: 'totalRevenue', label: '集团收入', numeric: true, render: (row) => format(row.totalRevenue) },
    { key: 'lineRevenue', label: '专线收入', numeric: true, render: (row) => format(row.lineRevenue) },
    { key: 'lineShare', label: '专线占比', numeric: true, render: (row) => percent(row.lineShare) },
    { key: 'previousRevenue', label: '上月收入', numeric: true, render: (row) => format(row.previousRevenue) },
    { key: 'change', label: '变化金额', numeric: true, render: (row) => <span className={tone(row.change)}>{signed(row.change)}</span> },
    { key: 'changeRate', label: '环比', numeric: true, render: (row) => percent(row.changeRate) }
  ];
  const loading = meta.loading || (group ? detail.loading : summary.loading);
  const failure = meta.error || (group ? detail.error : summary.error);
  const exportRows = group ? detail.data?.products : view === 'history' ? meta.data?.batches : view === 'groups' ? groups : data?.managers;
  const exportReady = !loading && !failure && Boolean(exportRows?.length);
  useEffect(() => { onExportReady?.(exportReady); }, [exportReady, onExportReady]);
  useImperativeHandle(ref, () => ({
    refresh,
    openImport: () => setImporting(true),
    exportData: async () => {
      if (!exportReady) return;
      setError('');
      try {
        const XLSX = await import('xlsx');
        const incomeFields = [['totalRevenue', '集团信息化收入'], ['lineRevenue', '报表专线收入'], ['lineShare', '专线占比'], ['previousRevenue', '上月收入'], ['change', '变化金额'], ['changeRate', '环比']];
        const fields = group
          ? [['productId', '产品编码'], ['productName', '产品名称'], ['category', '收入分类'], ['revenue', '本月收入'], ...incomeFields.slice(3)]
          : view === 'history'
            ? [['fileName', '文件名称'], ['months', '收入月份'], ['rowCount', '明细行数'], ['status', '批次状态'], ['activeMonths', '当前有效月份'], ['createdBy', '操作人'], ['createdAt', '导入时间']]
            : view === 'groups'
              ? [['groupCode', '集团编码'], ['groupName', '集团名称'], ['managerName', '客户经理'], ...incomeFields, ['supplementRevenue', '人工补录收入'], ['currentLineCount', '当前在用台账数']]
              : [['id', '客户经理工号'], ['name', '客户经理'], ['groupCount', '集团数'], ...incomeFields];
        const rows = exportRows.map((row) => Object.fromEntries(fields.map(([key, label]) => [label, row[key] ?? null])));
        const book = XLSX.utils.book_new();
        const sheet = XLSX.utils.json_to_sheet(rows);
        fields.forEach(([key], column) => {
          const format = ['lineShare', 'changeRate'].includes(key) ? '0.00%'
            : ['totalRevenue', 'lineRevenue', 'supplementRevenue', 'previousRevenue', 'revenue', 'change'].includes(key) ? '#,##0.00' : null;
          if (!format) return;
          rows.forEach((_, index) => {
            const cell = sheet[XLSX.utils.encode_cell({ r: index + 1, c: column })];
            if (cell?.t === 'n') cell.z = format;
          });
        });
        sheet['!cols'] = fields.map(() => ({ wch: 22 }));
        XLSX.utils.book_append_sheet(book, sheet, '收入明细');
        XLSX.writeFile(book, `集团收入-${month}-${group ? '产品' : view === 'groups' ? '集团' : view === 'history' ? '导入记录' : '客户经理'}.xlsx`);
      } catch (failure) { setError(failure.message || '收入导出失败，请重试'); }
    }
  }));
  return <main className="revenue-page">
    <div className="rev-toolbar"><div className="rev-breadcrumbs"><button onClick={() => { setGroup(null); setManager(null); setView('managers'); }}>收入总览</button>{(manager !== null || group) && <><ChevronRight size={14} /><button onClick={() => { setGroup(null); setView('groups'); }}>{managers.find((item) => item.id === manager)?.name || '集团列表'}</button></>}{group && <><ChevronRight size={14} /><span>集团详情</span></>}</div>
      <div className="rev-toolbar-actions"><label className="rev-month">收入月份<select aria-label="收入月份" disabled={!meta.data?.months.length} value={month} onChange={(event) => { setMonth(event.target.value); setMessage(''); }}><option value="" disabled>暂无收入月份</option>{meta.data?.months.map((item) => <option key={item}>{item}</option>)}</select></label><button title="核对设置" aria-label="核对设置" onClick={() => setSettingsOpen(!settingsOpen)}><Settings2 size={16} /></button></div>
    </div>
    <div className="rev-context"><span>信息化收入 · 原表金额单位</span><span>台账范围：{kpiMode ? 'KPI 十类产品' : '全部产品'} · 报表收入：全部产品</span></div>
    {message && <div className="rev-success" role="status">{message}<button title="关闭提示" aria-label="关闭提示" onClick={() => setMessage('')}><X size={14} /></button></div>}
    {error && <Notice error>{error}</Notice>}
    {settingsOpen && <form className="rev-settings" onSubmit={saveSettings}><label>舍入容差（原表金额单位）<input type="number" step="0.01" min="0" required value={tolerance} onChange={(event) => setTolerance(event.target.value)} /></label><button className="primary" disabled={settingBusy}><Save size={16} />保存</button>{settings.error && <Notice error>{settings.error}</Notice>}</form>}
    {importing && <ImportPanel onClose={() => setImporting(false)} onDone={(result) => { setImporting(false); setMessage(`导入完成：${result.months.join('、')}。报表明细已保存，展示范围以当前客户经理筛选为准。${result.invalidatedServices ? `${result.invalidatedServices} 项延伸服务需复核。` : ''}`); setMonth([...result.months].sort().at(-1)); setGroup(null); refresh(); }} />}
    {failure && <Notice error>{failure}<button onClick={refresh}><RefreshCw size={14} />重试</button></Notice>}
    {loading ? <Loader /> : !meta.data?.months.length ? <section className="rev-empty"><FileSpreadsheet size={42} strokeWidth={1.3} /><h2>暂无集团收入</h2><p>7、8、9 月报表导入后将在这里展示。</p></section> : group ? detail.data && <GroupDetail data={detail.data} month={month} onOpenLine={onOpenLine} onRefresh={refresh} /> : <>
      <div className="rev-view-controls"><div className="rev-segment" role="group" aria-label="收入视图"><button aria-pressed={view === 'managers'} onClick={() => { setView('managers'); setManager(null); }}><UsersRound size={16} />客户经理</button><button aria-pressed={view === 'groups'} onClick={() => { setView('groups'); setManager(null); }}><Building2 size={16} />集团</button><button aria-pressed={view === 'history'} onClick={() => setView('history')}><History size={16} />收入导入记录</button></div>{view !== 'history' && <ManagerPicker options={managers} selected={selected || []} onChange={(values) => { setSelected(values); setManager(null); }} />}</div>
      {view !== 'history' && <div className="rev-manager-scope" role="status" aria-label="客户经理筛选范围">
        <span>{scopedManagerIds.length ? scopedManagers.length ? `当前范围：${manager !== null ? scopedManagers[0].name : `已选 ${scopedManagers.length} 位客户经理`}，未选经理的集团未显示` : '当前范围：所选客户经理在收入报表中无匹配记录' : '当前范围：全部客户经理'}</span>
        <div className="rev-scope-actions" role="group" aria-label="客户经理快捷筛选">
          <button aria-pressed={scopedManagerIds.length === 0} onClick={() => { setSelected([]); setManager(null); }}><UsersRound size={15} />查看全部客户经理</button>
          <button aria-pressed={scopedManagerIds.length === defaultManagerIds.length && defaultManagerIds.every((id) => scopedManagerIds.includes(id))} onClick={() => { setSelected(defaultManagerIds); setManager(null); }}><ListChecks size={15} />指定18位客户经理</button>
        </div>
      </div>}
      {view === 'history' ? <section className="rev-section"><DataTable rows={meta.data.batches} rowKey="id" initialSort="createdAt" columns={[
        { key: 'fileName', label: '文件名称' }, { key: 'months', label: '收入月份' }, { key: 'rowCount', label: '明细行数', numeric: true },
        { key: 'status', label: '状态', render: (row) => row.status === 'preview' ? '预览（未计入）' : row.activeMonths ? '已导入' : '历史版本' },
        { key: 'activeMonths', label: '当前有效月份' }, { key: 'createdBy', label: '操作人' }, { key: 'createdAt', label: '时间', render: (row) => date(row.createdAt) }
      ]} /></section> : data && <>
        <Metrics data={data.summary} /><Trend rows={data.trend} />
        <section className="rev-section"><div className="rev-section-heading"><h3>{view === 'managers' ? '客户经理收入' : `${managers.find((item) => item.id === manager)?.name || '全部'}集团`} <span>{view === 'managers' ? data.managers.length : groups.length}</span></h3><span className="rev-caption">各月按报表归属统计</span></div>
          {view === 'groups' && <div className="rev-group-filters"><label className="rev-search"><Search size={16} /><input aria-label="搜索集团" placeholder="集团名称或集团编码" value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label><select aria-label="集团状态筛选" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部集团</option><option value="decline">收入下降</option><option value="unmatched">台账未匹配</option><option value="review">补录待复核</option></select></div>}
          {view === 'managers' ? <DataTable rows={data.managers} rowKey="id" initialSort="totalRevenue" columns={[
            { key: 'name', label: '客户经理', render: (row) => <button className="rev-link rev-cell-stack" onClick={() => { setManager(row.id); setView('groups'); }}><strong>{row.name}</strong><small>{row.id}</small></button> },
            { key: 'groupCount', label: '集团数', numeric: true }, ...revenueColumns
          ]} empty="所选客户经理本月无报表记录" /> : <DataTable rows={groups} rowKey="groupCode" initialSort="totalRevenue" columns={[
            { key: 'groupName', label: '集团', render: (row) => <button className="rev-link rev-cell-stack rev-group-name" onClick={() => setGroup(row.groupCode)}><strong>{row.groupName || '未填写集团名称'}</strong><small>{row.groupCode}</small></button> },
            { key: 'managerName', label: '客户经理', render: (row) => <div className="rev-cell-stack"><span>{row.managerName}</span>{row.managerChanged && <small>归属已变更</small>}</div> }, ...revenueColumns,
            { key: 'currentLineCount', label: '当前在用台账', numeric: true }, { key: 'matched', label: '匹配状态', render: (row) => row.matched ? '已匹配' : <span className="rev-warning-text">台账未匹配</span> },
            { key: 'needsReviewCount', label: '服务待复核', numeric: true }
          ]} />}
        </section>
        <div className="rev-footnote"><span>覆盖 {meta.data.months.length} 个月 · 本月所选集团 {data.summary.groupCount} 个</span><span>全报表无集团收入 {format(data.summary.ungroupedRevenue)}，单列保留</span></div>
      </>}
    </>}
  </main>;
}
