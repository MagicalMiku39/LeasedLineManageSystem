import React, { useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { Check, ListChecks, Pencil, Plus, Trash2, Undo2, UsersRound } from 'lucide-react';
import { isAbort, jsonBody, requestJson } from './api.js';
import { InlineError } from './components/Feedback.jsx';
import { kpiManagerRows } from './kpiRows.js';
import { defaultManagers } from './ledger/config.js';
import { netClass, signedNumber } from './utils.js';

const emptyForm = { kind: 'added', group_code: '', group_name: '', manager_name: '', product_type: '', line_count: '', month: '' };
const kindLabels = { added: '新增', cancelled: '销户' };
// What "done" means for each kind of forecast once the real change is in the ledger.
const landedLabels = { added: '已落地', cancelled: '已销户' };

function percent(value, target) {
  if (!target) return '—';
  return `${((value / target) * 100).toFixed(1)}%`;
}

function Metric({ label, value, className, note }) {
  return (
    <div className="kpi-metric">
      <span>{label}</span>
      <strong className={className}>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function useGroupMatches(keyword) {
  const [state, setState] = useState({ keyword: '', groups: [] });
  useEffect(() => {
    const term = keyword.trim();
    if (!term) {
      setState({ keyword: '', groups: [] });
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      requestJson(`/kpi/groups?${new URLSearchParams({ q: term })}`, { signal: controller.signal })
        .then((groups) => setState({ keyword: term, groups }))
        .catch((error) => { if (!isAbort(error)) setState({ keyword: term, groups: [] }); });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [keyword]);
  return state;
}

export default function KpiAchievement({ ref, kpiMode, refreshToken }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [scope, setScope] = useState('defaults');
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [targetDraft, setTargetDraft] = useState(null);
  const [targetError, setTargetError] = useState('');
  const [targetSaving, setTargetSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    requestJson(`/kpi?${new URLSearchParams({ kpiMode: kpiMode ? '1' : '0' })}`, { signal: controller.signal })
      .then((value) => {
        setData(value);
        setLoading(false);
      })
      .catch((err) => {
        if (isAbort(err)) return;
        setError(`KPI 数据加载失败：${err.message}`);
        setLoading(false);
      });
    return () => controller.abort();
  }, [kpiMode, refreshToken, revision]);

  const reload = () => setRevision((value) => value + 1);
  const forecasts = data?.forecasts || [];
  const managerRows = useMemo(() => kpiManagerRows(data?.managers || [], forecasts, scope), [data, forecasts, scope]);
  const scopeTotal = useMemo(() => managerRows.reduce((sum, row) => ({
    added: sum.added + row.added,
    cancelled: sum.cancelled + row.cancelled,
    net: sum.net + row.net,
    forecastAdded: sum.forecastAdded + row.forecastAdded,
    forecastCancelled: sum.forecastCancelled + row.forecastCancelled,
    expectedNet: sum.expectedNet + row.expectedNet
  }), { added: 0, cancelled: 0, net: 0, forecastAdded: 0, forecastCancelled: 0, expectedNet: 0 }), [managerRows]);

  const matches = useGroupMatches(form.group_code);
  const code = form.group_code.trim();
  const matched = matches.groups.find((group) => group.group_code === code) || null;
  // Only after the lookup for this exact code came back empty is the group treated as new.
  const unknownGroup = Boolean(code) && matches.keyword === code && !matched;
  const managerChoices = useMemo(
    () => [...new Set([...defaultManagers, ...(data?.managers || []).map((row) => row.manager_name).filter((name) => name !== '未填写')])],
    [data]
  );

  useImperativeHandle(ref, () => ({
    refresh: reload,
    exportData: async () => {
      if (loading || !data) return;
      try {
        const module = await import('xlsx');
        const XLSX = module.default || module;
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(managerRows.map((row) => ({
          客户经理: row.manager_name, 新增: row.added, 销户: row.cancelled, 净增: row.net,
          预计新增: row.forecastAdded, 预计销户: row.forecastCancelled, 预计净增: row.expectedNet
        }))), '客户经理净增');
        XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(forecasts.map((row) => ({
          预计类别: kindLabels[row.kind], 月份: `${row.month}月`, 集团编码: row.group_code, 集团名称: row.group_name, 客户经理: row.manager_name,
          产品类型: row.product_type, 条数: row.line_count, 状态: row.landed ? landedLabels[row.kind] : '预计'
        })), { header: ['预计类别', '月份', '集团编码', '集团名称', '客户经理', '产品类型', '条数', '状态'] }), '预计新增与销户');
        XLSX.writeFile(book, `KPI达成-${data.year}.xlsx`);
      } catch (err) { setError(`导出失败：${err.message}`); }
    }
  }), [loading, data, managerRows, forecasts]);

  function updateForm(field, value) {
    setFormError('');
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function addForecast(event) {
    event.preventDefault();
    setFormError('');
    setSaving(true);
    try {
      await requestJson('/kpi/forecasts', jsonBody('POST', {
        kind: form.kind,
        group_code: code,
        group_name: matched ? matched.group_name : form.group_name.trim(),
        manager_name: matched ? matched.manager_name : form.manager_name,
        product_type: form.product_type,
        line_count: Number(form.line_count),
        month: Number(form.month)
      }));
      setForm((current) => ({ ...emptyForm, kind: current.kind, product_type: current.product_type, month: current.month }));
      reload();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function changeForecast(row, request) {
    setBusyId(row.id);
    setError('');
    try {
      await requestJson(`/kpi/forecasts/${row.id}`, request);
      setConfirmDelete(null);
      reload();
    } catch (err) {
      setError(`预计记录保存失败：${err.message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function saveTarget(event) {
    event.preventDefault();
    setTargetError('');
    setTargetSaving(true);
    try {
      await requestJson('/kpi/target', jsonBody('PUT', { target: Number(targetDraft) }));
      setTargetDraft(null);
      reload();
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setTargetSaving(false);
    }
  }

  const target = data?.target;
  const actual = data?.actual;
  const forecast = data?.forecast;
  const show = (value) => (loading || !data ? '—' : value);
  const gap = forecast ? target - forecast.expectedNet : 0;
  const actualShare = actual ? Math.max(0, Math.min(1, actual.net / target)) : 0;
  // Forecast cancellations that outweigh forecast additions only lower the total; the bar then shows no forecast part.
  const forecastShare = actual && forecast ? Math.max(0, Math.min(1 - actualShare, forecast.net / target)) : 0;
  const monthNote = (field) => data.months.map((month) => `${month}月 ${forecast.byMonth[month]?.[field] || 0}`).join(' · ');
  const kindLabel = kindLabels[form.kind];

  return (
    <>
      <section className="operations-heading">
        <div>
          <h2>KPI 达成</h2>
          <p className="operations-rule">
            {data ? `${data.year} 年度目标为净增 ${target} 条专线。` : ''}净增 = 新增 − 销户，新增按开始时间、销户按状态时间，与台账年度统计口径一致，遵循 KPI 统计模式。
          </p>
        </div>
      </section>
      <InlineError message={error} onRetry={reload} />

      <div className="kpi-columns">
        <section className="kpi-panel" aria-label="年度净增">
          <h3>年度净增</h3>
          <div className="kpi-metrics">
            {targetDraft === null ? (
              <div className="kpi-metric">
                <span className="kpi-target-label">
                  年度目标
                  <button type="button" className="text-button" disabled={!data || loading} title="修改本年度目标" onClick={() => { setTargetError(''); setTargetDraft(String(target)); }}>
                    <Pencil size={13} /> 修改
                  </button>
                </span>
                <strong>{show(target)}</strong>
                {data && target !== data.defaultTarget && <small>默认 {data.defaultTarget}</small>}
              </div>
            ) : (
              <form className="kpi-metric kpi-target-form" onSubmit={saveTarget}>
                <label>
                  <span>{data.year} 年度目标（净增条数）</span>
                  <input type="number" min="1" step="1" inputMode="numeric" value={targetDraft} onChange={(event) => setTargetDraft(event.target.value)} autoFocus required />
                </label>
                <div className="kpi-target-actions">
                  <button type="submit" className="primary" disabled={targetSaving}>{targetSaving ? '保存中…' : '保存'}</button>
                  <button type="button" disabled={targetSaving} onClick={() => { setTargetDraft(null); setTargetError(''); }}>取消</button>
                </div>
                {targetError && <small role="alert" className="operations-error">{targetError}</small>}
              </form>
            )}
            <Metric label="已新增" value={show(actual?.added)} className="kpi-added" />
            <Metric label="已销户" value={show(actual?.cancelled)} className="kpi-cancelled" />
            <Metric label="年度净增" value={show(signedNumber(actual?.net))} className={actual ? netClass(actual.net) : undefined} note={actual ? `完成 ${percent(actual.net, target)}` : undefined} />
          </div>

          <div className="kpi-table-head">
            <h4>客户经理净增</h4>
            <div className="scope-actions" role="group" aria-label="客户经理范围">
              <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
                <UsersRound size={15} /> 查看全部客户经理
              </button>
              <button type="button" aria-pressed={scope === 'defaults'} onClick={() => setScope('defaults')}>
                <ListChecks size={15} /> 指定18位客户经理
              </button>
            </div>
          </div>
          <div className="table-scroll kpi-table-scroll">
            <table className="data-table kpi-table">
              <thead>
                <tr>
                  <th>客户经理</th>
                  <th className="num">新增</th>
                  <th className="num">销户</th>
                  <th className="num">净增</th>
                  <th className="num">预计新增</th>
                  <th className="num">预计销户</th>
                  <th className="num">预计净增</th>
                </tr>
              </thead>
              <tbody>
                {!loading && data && managerRows.map((row) => (
                  <tr key={row.manager_name}>
                    <td>{row.manager_name}</td>
                    <td className="num kpi-added">{row.added}</td>
                    <td className="num kpi-cancelled">{row.cancelled}</td>
                    <td className={`num ${netClass(row.net)}`}><strong>{signedNumber(row.net)}</strong></td>
                    <td className="num">{row.forecastAdded}</td>
                    <td className="num">{row.forecastCancelled}</td>
                    <td className={`num ${netClass(row.expectedNet)}`}>{signedNumber(row.expectedNet)}</td>
                  </tr>
                ))}
                {(loading || !data || managerRows.length === 0) && (
                  <tr className="state-row">
                    <td colSpan="7" className="empty">{loading ? '正在统计…' : error ? '加载失败，请重试' : '本年度暂无新增或销户'}</td>
                  </tr>
                )}
              </tbody>
              {!loading && data && managerRows.length > 0 && (
                <tfoot>
                  <tr>
                    <td>{scope === 'defaults' ? '18 人合计' : '合计'}</td>
                    <td className="num">{scopeTotal.added}</td>
                    <td className="num">{scopeTotal.cancelled}</td>
                    <td className={`num ${netClass(scopeTotal.net)}`}>{signedNumber(scopeTotal.net)}</td>
                    <td className="num">{scopeTotal.forecastAdded}</td>
                    <td className="num">{scopeTotal.forecastCancelled}</td>
                    <td className={`num ${netClass(scopeTotal.expectedNet)}`}>{signedNumber(scopeTotal.expectedNet)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>

        <section className="kpi-panel" aria-label="预计达成">
          <h3>预计达成</h3>
          <div className="kpi-metrics">
            <Metric label="当前净增" value={show(signedNumber(actual?.net))} className={actual ? netClass(actual.net) : undefined} />
            <Metric label="预计新增" value={show(forecast?.added)} className="kpi-added" note={forecast ? monthNote('added') : undefined} />
            <Metric label="预计销户" value={show(forecast?.cancelled)} className="kpi-cancelled" note={forecast ? monthNote('cancelled') : undefined} />
            <Metric label="预计年度净增" value={show(signedNumber(forecast?.expectedNet))} className={forecast ? netClass(forecast.expectedNet) : undefined} />
            <Metric
              label="预计完成率"
              value={show(percent(forecast?.expectedNet, target))}
              note={forecast ? (gap > 0 ? `距目标还差 ${gap} 条` : `超出目标 ${-gap} 条`) : undefined}
            />
          </div>
          {data && !loading && (
            <div className="kpi-progress" role="img" aria-label={`当前净增 ${actual.net} 条，预计新增 ${forecast.added} 条、预计销户 ${forecast.cancelled} 条，目标 ${target} 条`}>
              <span className="kpi-progress-actual" style={{ width: `${actualShare * 100}%` }} />
              <span className="kpi-progress-forecast" style={{ width: `${forecastShare * 100}%` }} />
            </div>
          )}
          {data && !loading && (
            <p className="kpi-legend"><span className="kpi-dot kpi-dot-actual" />当前净增<span className="kpi-dot kpi-dot-forecast" />预计净增（新增 − 销户）<span className="kpi-legend-target">目标 {target}</span></p>
          )}

          <form className="kpi-form" onSubmit={addForecast}>
            <h4>填写预计新增或销户</h4>
            <div className="scope-actions kpi-kind" role="group" aria-label="预计类别">
              {Object.entries(kindLabels).map(([kind, label]) => (
                <button key={kind} type="button" aria-pressed={form.kind === kind} onClick={() => updateForm('kind', kind)}>预计{label}</button>
              ))}
            </div>
            <label>
              集团编码
              <input
                list="kpi-group-options"
                value={form.group_code}
                placeholder="输入编码或名称查找"
                autoComplete="off"
                onChange={(event) => updateForm('group_code', event.target.value)}
                required
              />
              <datalist id="kpi-group-options">
                {matches.groups.map((group) => (
                  <option key={group.group_code} value={group.group_code}>{`${group.group_name} · ${group.manager_name || '未填写'}`}</option>
                ))}
              </datalist>
            </label>
            <label>
              集团名称
              <input
                value={matched ? matched.group_name : form.group_name}
                readOnly={!unknownGroup}
                placeholder={unknownGroup ? '新集团，请填写名称' : '选中集团编码后自动带出'}
                onChange={(event) => updateForm('group_name', event.target.value)}
                required={unknownGroup}
              />
            </label>
            <label>
              客户经理
              {unknownGroup ? (
                <select value={form.manager_name} onChange={(event) => updateForm('manager_name', event.target.value)} required>
                  <option value="">选择客户经理</option>
                  {managerChoices.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              ) : (
                <input value={matched ? matched.manager_name || '未填写' : ''} readOnly placeholder="选中集团编码后自动带出" />
              )}
            </label>
            <label>
              预计{kindLabel}类型
              <select value={form.product_type} onChange={(event) => updateForm('product_type', event.target.value)} required>
                <option value="">选择产品类型</option>
                {(data?.productTypes || []).map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label>
              预计{kindLabel}条数
              <input type="number" min="1" step="1" inputMode="numeric" value={form.line_count} onChange={(event) => updateForm('line_count', event.target.value)} required />
            </label>
            <label>
              预计{kindLabel}月份
              <select value={form.month} onChange={(event) => updateForm('month', event.target.value)} required>
                <option value="">选择月份</option>
                {(data?.months || [11, 12]).map((month) => <option key={month} value={month}>{month}月</option>)}
              </select>
            </label>
            {unknownGroup && <p className="kpi-form-hint">台账中没有该集团编码，按新集团登记，请手动填写名称并选择客户经理。</p>}
            {formError && <p role="alert" className="operations-error kpi-form-hint">{formError}</p>}
            <div className="kpi-form-actions">
              <button type="submit" className="primary" disabled={saving || !data || (Boolean(code) && !matched && !unknownGroup)}>
                <Plus size={16} /> {saving ? '保存中…' : `添加预计${kindLabel}`}
              </button>
            </div>
          </form>

          <div className="table-scroll kpi-table-scroll">
            <table className="data-table kpi-table">
              <thead>
                <tr>
                  <th>类别</th>
                  <th>月份</th>
                  <th>集团编码</th>
                  <th>集团名称</th>
                  <th>客户经理</th>
                  <th>类型</th>
                  <th className="num">条数</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {!loading && forecasts.map((row) => (
                  <tr key={row.id} className={row.landed ? 'kpi-landed' : undefined}>
                    <td className={row.landed ? undefined : row.kind === 'cancelled' ? 'kpi-cancelled' : 'kpi-added'}>{kindLabels[row.kind]}</td>
                    <td>{row.month}月</td>
                    <td>{row.group_code}</td>
                    <td>{row.group_name}</td>
                    <td>{row.manager_name}</td>
                    <td>{row.product_type}</td>
                    <td className="num">{row.line_count}</td>
                    <td>
                      <div className="kpi-row-actions">
                        <button
                          type="button"
                          disabled={busyId !== null}
                          title={row.landed
                            ? '恢复为预计，重新计入预计达成'
                            : row.kind === 'cancelled' ? '专线已实际销户，不再计入预计销户' : '专线已实际开通，不再计入预计新增'}
                          onClick={() => changeForecast(row, jsonBody('PATCH', { landed: !row.landed }))}
                        >
                          {row.landed ? <><Undo2 size={14} /> 恢复预计</> : <><Check size={14} /> {landedLabels[row.kind]}</>}
                        </button>
                        {confirmDelete === row.id ? (
                          <button type="button" className="kpi-danger" disabled={busyId !== null} onClick={() => changeForecast(row, { method: 'DELETE' })}>
                            确认删除
                          </button>
                        ) : (
                          <button type="button" disabled={busyId !== null} aria-label="删除" title="删除" onClick={() => setConfirmDelete(row.id)}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {(loading || forecasts.length === 0) && (
                  <tr className="state-row">
                    <td colSpan="8" className="empty">{loading ? '正在加载…' : '暂无预计新增或销户，可在上方填写'}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="operations-rule">预计年度净增 = 当前净增 + 预计新增 − 预计销户，只计尚未落地的预计。专线实际开通或销户、已体现在台账中后，请点“已落地”或“已销户”，避免重复计算。</p>
        </section>
      </div>
    </>
  );
}
