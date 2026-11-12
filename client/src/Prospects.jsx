import React, { useEffect, useMemo, useState } from 'react';
import { Building2, ChevronLeft, ChevronRight, ListChecks, Search, UsersRound, X } from 'lucide-react';
import { isAbort, jsonBody, requestJson } from './api.js';
import { Loader, Metric, Notice } from './GroupRevenue.jsx';
import { defaultManagers } from './ledger/config.js';
import { money } from './utils.js';

const types = [
  { key: 'never', label: '未开通专线' },
  { key: 'lost', label: '已流失' }
];
const focusFilters = [
  { key: '', label: '全部集团' },
  { key: 'strategic', label: '战客' },
  { key: 'key', label: '要客' },
  { key: 'a', label: 'A 级集团' }
];
const followFilters = [
  { key: '', label: '全部（不含已排除）' },
  { key: 'none', label: '未标记' },
  { key: 'contacted', label: '已联系' },
  { key: 'paused', label: '暂不跟进' },
  { key: 'excluded', label: '已排除' }
];
const followOptions = [
  { key: '', label: '未标记' },
  { key: 'contacted', label: '已联系' },
  { key: 'paused', label: '暂不跟进' },
  { key: 'excluded', label: '已排除' }
];
const sorts = [
  { key: 'priority', label: '综合：战客、要客、级别、规模' },
  { key: 'employees', label: '企业员工数' },
  { key: 'billing', label: '成员出账金额' }
];
const count = (value) => (value == null ? '—' : Number(value).toLocaleString('zh-CN'));

// One prospect's follow-up mark and note; the note saves when the field is left.
function FollowCell({ row, onSaved }) {
  const [status, setStatus] = useState(row.followStatus || '');
  const [note, setNote] = useState(row.followNote || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setStatus(row.followStatus || '');
    setNote(row.followNote || '');
  }, [row.followStatus, row.followNote]);

  async function save(nextStatus, nextNote) {
    if (nextStatus === (row.followStatus || '') && nextNote.trim() === (row.followNote || '')) return;
    setBusy(true);
    setError('');
    try {
      await requestJson(`/groups/${encodeURIComponent(row.groupCode)}/followup`, jsonBody('PUT', { status: nextStatus, note: nextNote }));
      onSaved();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="prospect-follow">
      <select aria-label={`${row.groupName || row.groupCode}的跟进状态`} value={status} disabled={busy} onChange={(event) => { setStatus(event.target.value); save(event.target.value, note); }}>
        {followOptions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select>
      <input aria-label={`${row.groupName || row.groupCode}的跟进备注`} placeholder="备注" maxLength={200} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} onBlur={() => save(status, note)} />
      {error && <small className="rev-negative" role="alert">{error}</small>}
    </div>
  );
}

/**
 * 潜客清单: groups with no line in service. 未开通 has never had a line in the ledger; 已流失 had
 * lines and all are cancelled. Ranked so the most valuable come first, by group or per manager.
 */
export default function Prospects({ kpiMode, stamp, onOpenGroup, onForecast, onQuery, Badges }) {
  const [revision, setRevision] = useState(0);
  const [type, setType] = useState('never');
  const [view, setView] = useState('groups');
  const [manager, setManager] = useState(null);
  const [onlyDefaults, setOnlyDefaults] = useState(false);
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState('');
  const [follow, setFollow] = useState('');
  const [sort, setSort] = useState('priority');
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, data: null, error: '' });

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(typed.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const query = new URLSearchParams({
    kpiMode: kpiMode ? '1' : '0', type, sort: type === 'lost' && sort === 'priority' ? 'cancelled' : sort,
    ...(search && { search }), ...(focus && { focus }), ...(follow && { follow }), ...(manager !== null && { manager: manager || '未填写' })
  }).toString();

  useEffect(() => { onQuery(query); }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));
    requestJson(`/groups/prospects?${query}&page=${page}`, { signal: controller.signal })
      .then((data) => setState({ loading: false, data, error: '' }))
      .catch((error) => { if (!isAbort(error)) setState({ loading: false, data: null, error: error.message }); });
    return () => controller.abort();
  }, [query, page, stamp, revision]);

  const data = state.data;
  const summary = data?.summary;
  const managers = useMemo(() => {
    const rows = data?.managers || [];
    if (!onlyDefaults) return rows;
    const known = new Map(rows.map((row) => [row.name, row]));
    return defaultManagers.map((name) => known.get(name) || { name, never: 0, lost: 0, neverStrategic: 0, neverKey: 0, neverA: 0 });
  }, [data, onlyDefaults]);
  const pick = (setter) => (event) => { setter(event.target.value); setPage(1); };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const lost = type === 'lost';

  function openManager(name) {
    setManager(name === '未填写' ? '' : name);
    setView('groups');
    setPage(1);
  }

  if (!data) return state.error ? <Notice error>{state.error}</Notice> : <Loader />;

  return (
    <>
      {state.error && <Notice error>{state.error}</Notice>}
      <section className="rev-metrics" aria-label="潜客概览">
        <Metric label="未开通专线" value={count(summary.never)} note="台账中没有专线，不含已排除" />
        <Metric label="其中战客" value={count(summary.neverStrategic)} className={summary.neverStrategic > 0 ? 'rev-positive' : ''} note="重点客户，尚无专线" />
        <Metric label="其中要客" value={count(summary.neverKey)} className={summary.neverKey > 0 ? 'rev-positive' : ''} note={`另有 A 级集团 ${count(summary.neverA)} 个`} />
        <Metric label="已流失" value={count(summary.lost)} className={summary.lost > 0 ? 'rev-negative' : ''} note="曾有专线，现已全部销户" />
      </section>

      <div className="rev-view-controls prospect-controls">
        <div className="rev-segment" role="group" aria-label="潜客类型">
          {types.map((item) => <button key={item.key} aria-pressed={type === item.key} onClick={() => { setType(item.key); setPage(1); }}>{item.label}</button>)}
        </div>
        <div className="rev-segment" role="group" aria-label="潜客视图">
          <button aria-pressed={view === 'managers' && manager === null} onClick={() => { setView('managers'); setManager(null); }}><UsersRound size={16} />客户经理</button>
          <button aria-pressed={view === 'groups' || manager !== null} onClick={() => setView('groups')}><Building2 size={16} />集团</button>
        </div>
      </div>

      {view === 'managers' && manager === null ? (
        <section className="rev-section">
          <div className="rev-section-heading">
            <h3>各客户经理的潜客 <span>{managers.length}</span></h3>
            <span className="rev-caption">点击客户经理查看其名下的集团 · 战客和要客多的排在前面</span>
          </div>
          <div className="rev-manager-scope" role="status">
            <span>{onlyDefaults ? '当前范围：指定 18 位客户经理' : '当前范围：全部客户经理'}</span>
            <div className="rev-scope-actions" role="group" aria-label="客户经理快捷筛选">
              <button aria-pressed={!onlyDefaults} onClick={() => setOnlyDefaults(false)}><UsersRound size={15} />查看全部客户经理</button>
              <button aria-pressed={onlyDefaults} onClick={() => setOnlyDefaults(true)}><ListChecks size={15} />指定18位客户经理</button>
            </div>
          </div>
          <div className="rev-table-scroll" tabIndex={0} role="region" aria-label="各客户经理的潜客">
            <table className="rev-table">
              <thead><tr><th>客户经理</th><th className="rev-number">未开通专线</th><th className="rev-number">其中战客</th><th className="rev-number">其中要客</th><th className="rev-number">其中 A 级</th><th className="rev-number">已流失</th></tr></thead>
              <tbody>
                {managers.slice(0, 200).map((row) => (
                  <tr key={row.name}>
                    <td><button className="rev-link" onClick={() => openManager(row.name)}>{row.name}</button></td>
                    <td className="rev-number">{count(row.never)}</td>
                    <td className="rev-number">{count(row.neverStrategic)}</td>
                    <td className="rev-number">{count(row.neverKey)}</td>
                    <td className="rev-number">{count(row.neverA)}</td>
                    <td className="rev-number"><span className={row.lost > 0 ? 'rev-negative' : ''}>{count(row.lost)}</span></td>
                  </tr>
                ))}
                {!managers.length && <tr><td colSpan="6" className="rev-empty-cell">没有潜客</td></tr>}
              </tbody>
            </table>
          </div>
          {managers.length > 200 && <p className="rev-caption prospect-more">共 {count(managers.length)} 位客户经理，这里显示前 200 位；其余可在“集团”视图中搜索姓名。</p>}
        </section>
      ) : (
        <section className="rev-section">
          <div className="rev-section-heading">
            <h3>{manager !== null ? `${manager || '未填写客户经理'} · ` : ''}{lost ? '已流失集团' : '未开通专线的集团'} <span>{count(data.total)}</span></h3>
            <span className="rev-caption">{lost ? '按已销户专线数从多到少' : '没有数据的项显示“—”，排在有数据的之后'}</span>
          </div>
          {manager !== null && (
            <p className="group-hints">
              <button type="button" className="text-button" onClick={() => { setManager(null); setPage(1); }}><X size={13} /> 取消只看 {manager || '未填写客户经理'}</button>
            </p>
          )}
          <div className="rev-group-filters group-filters">
            <label className="rev-search"><Search size={16} /><input aria-label="搜索潜客" placeholder="集团名称、集团编码或客户经理" value={typed} onChange={(event) => setTyped(event.target.value)} /></label>
            <select aria-label="重点客户" value={focus} onChange={pick(setFocus)}>{focusFilters.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select>
            <select aria-label="跟进状态" value={follow} onChange={pick(setFollow)}>{followFilters.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select>
            {!lost && <select aria-label="排序" value={sort} onChange={pick(setSort)}>{sorts.map((item) => <option key={item.key} value={item.key}>按{item.label}</option>)}</select>}
          </div>
          <div className={`rev-table-scroll${state.loading ? ' group-loading' : ''}`} tabIndex={0} role="region" aria-label="潜客清单">
            <table className="rev-table prospect-table">
              <thead>
                <tr>
                  <th>集团</th><th>客户经理</th><th>级别</th>
                  <th className="rev-number">企业员工数</th><th className="rev-number">移动成员数</th><th className="rev-number">成员出账金额</th>
                  {lost && <th className="rev-number">已销户专线</th>}
                  <th>跟进</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.groupCode}>
                    <td>
                      <button className="rev-link rev-cell-stack rev-group-name" onClick={() => onOpenGroup(row.groupCode)}>
                        <strong>{row.groupName || '未填写集团名称'}</strong>
                        <small>{row.groupCode}</small>
                      </button>
                      <span className="group-badges"><Badges group={row} /></span>
                    </td>
                    <td>{row.managerName || '—'}</td>
                    <td>{row.level || '—'}</td>
                    <td className="rev-number">{count(row.employeeCount)}</td>
                    <td className="rev-number">{count(row.mobileMemberCount)}</td>
                    <td className="rev-number">{row.memberBilling == null ? '—' : money(row.memberBilling)}</td>
                    {lost && <td className="rev-number">{row.cancelledLines}</td>}
                    <td><FollowCell row={row} onSaved={() => setRevision((value) => value + 1)} /></td>
                    <td><button type="button" className="prospect-forecast" onClick={() => onForecast(row.groupCode)}>登记预计新增</button></td>
                  </tr>
                ))}
                {!data.rows.length && <tr><td colSpan={lost ? 9 : 8} className="rev-empty-cell">{search || focus || follow || manager !== null ? '没有符合条件的集团' : lost ? '没有已流失的集团' : '没有未开通专线的集团；请先在“全部集团”中导入全量集团清单'}</td></tr>}
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
      )}
    </>
  );
}
