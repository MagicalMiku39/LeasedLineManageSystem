import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Search } from 'lucide-react';
import './app.css';
import './fill.css';
import { jsonBody, requestJson } from './api.js';
import { confidenceName } from './kpiRows.js';
import { beijingTime, money } from './utils.js';

const fieldLabels = {
  actual_monthly_fee: '实际月资费（元）',
  contract_no: '合同编号',
  contract_start_date: '合同开始日期',
  contract_end_date: '合同结束日期',
  renewal_status: '续约状态',
  customer_contact: '客户联系人',
  customer_phone: '联系电话',
  project_name: '项目名称',
  remark: '备注'
};
const fieldTypes = { actual_monthly_fee: 'number', contract_start_date: 'date', contract_end_date: 'date', customer_phone: 'tel' };
const day = (value) => (value ? String(value).slice(0, 10) : '—');
const text = (value) => (value === null || value === undefined ? '' : String(value));

// One line: its facts, and the fields this link may fill in.
function LineCard({ line, fields, token, onSaved }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(() => Object.fromEntries(fields.map((field) => [field, text(line[field])])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const filled = fields.filter((field) => text(line[field]) !== '').length;
  const dirty = fields.some((field) => form[field].trim() !== text(line[field]));

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setDone('');
    try {
      const changed = Object.fromEntries(fields.filter((field) => form[field].trim() !== text(line[field])).map((field) => [field, form[field].trim()]));
      const result = await requestJson(`/fill/${token}/lines/${line.id}`, jsonBody('POST', changed));
      if (result.line) {
        onSaved(result.line);
        setForm(Object.fromEntries(fields.map((field) => [field, text(result.line[field])])));
      }
      setDone(`已保存 ${result.changed} 项`);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="fill-card">
      <button type="button" className="fill-card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>
          <strong>{line.group_name || '未填写集团名称'}</strong>
          <small>{line.group_product_code || `记录 ${line.id}`} · {line.product_name || '—'}{line.bandwidth ? ` · ${line.bandwidth}` : ''} · {line.status}</small>
          <small>已填 {filled} / {fields.length} 项{done ? ` · ${done}` : ''}</small>
        </span>
        {open ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
      </button>
      {open && (
        <form className="fill-form" onSubmit={save}>
          <p className="fill-facts">开通 {day(line.start_time)} · 套餐资费 {line.package_fee == null ? '—' : `${money(line.package_fee)} 元`}{line.group_user_name ? ` · ${line.group_user_name}` : ''}</p>
          <div className="fill-fields">
            {fields.map((field) => (
              <label key={field} className={field === 'remark' ? 'fill-wide' : undefined}>
                {fieldLabels[field] || field}
                <input
                  type={fieldTypes[field] || 'text'}
                  inputMode={field === 'actual_monthly_fee' ? 'decimal' : undefined}
                  min={field === 'actual_monthly_fee' ? 0 : undefined}
                  step={field === 'actual_monthly_fee' ? 'any' : undefined}
                  maxLength={200}
                  value={form[field]}
                  disabled={busy}
                  onChange={(event) => { setForm({ ...form, [field]: event.target.value }); setDone(''); }}
                />
              </label>
            ))}
          </div>
          {error && <p className="fill-error" role="alert">{error}</p>}
          <div className="fill-actions">
            {done && <span className="fill-done" role="status"><Check size={15} /> {done}</span>}
            <button type="submit" className="primary" disabled={busy || !dirty}>{busy ? '正在保存…' : '保存'}</button>
          </div>
        </form>
      )}
    </li>
  );
}

function ForecastCard({ forecast, token, onSaved }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [landed, setLanded] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const cancelled = forecast.kind === 'cancelled';

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const saved = await requestJson(`/fill/${token}/forecasts/${forecast.id}/progress`, jsonBody('POST', { note, landed_count: landed === '' ? undefined : Number(landed) }));
      onSaved({ ...forecast, ...saved, latest_note: note.trim(), latest_at: new Date().toISOString() });
      setNote('');
      setLanded('');
      setDone(true);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="fill-card">
      <button type="button" className="fill-card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>
          <strong>{forecast.group_name}</strong>
          <small>
            {forecast.year}年{forecast.month}月 · <span className={cancelled ? 'net-negative' : 'net-positive'}>{cancelled ? '预计销户' : '预计新增'}</span> · {forecast.product_type} · {forecast.line_count} 条，已{cancelled ? '销户' : '落地'} {forecast.landed_count} 条 · {confidenceName(forecast.kind, forecast.confidence)}
          </small>
          <small>{forecast.latest_note ? `最新进展：${forecast.latest_note}（${beijingTime(forecast.latest_at)}）` : '还没有进展记录'}</small>
        </span>
        {open ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
      </button>
      {open && (
        <form className="fill-form" onSubmit={save}>
          <div className="fill-fields">
            <label className="fill-wide">
              进展说明
              <textarea required rows={3} maxLength={500} value={note} disabled={busy} placeholder="例如：客户已确认方案，等待合同盖章" onChange={(event) => { setNote(event.target.value); setDone(false); }} />
            </label>
            <label>
              已{cancelled ? '销户' : '落地'}条数（不变可不填，现为 {forecast.landed_count}）
              <input type="number" inputMode="numeric" min={0} max={forecast.line_count} step={1} value={landed} disabled={busy} placeholder={`0–${forecast.line_count}`} onChange={(event) => setLanded(event.target.value)} />
            </label>
          </div>
          {error && <p className="fill-error" role="alert">{error}</p>}
          <div className="fill-actions">
            {done && <span className="fill-done" role="status"><Check size={15} /> 已提交</span>}
            <button type="submit" className="primary" disabled={busy || !note.trim()}>{busy ? '正在提交…' : '提交进展'}</button>
          </div>
        </form>
      )}
    </li>
  );
}

function ReportForm({ report, token, manager }) {
  const empty = { kind: 'added', group_code: '', group_name: '', product_type: '', period: '', line_count: '', confidence: '' };
  const [form, setForm] = useState(empty);
  const [matches, setMatches] = useState({ keyword: '', groups: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState([]);
  const code = form.group_code.trim();
  const matched = matches.groups.find((group) => group.group_code === code) || null;
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  useEffect(() => {
    if (code.length < 2) {
      setMatches({ keyword: '', groups: [] });
      return undefined;
    }
    const timer = setTimeout(() => {
      requestJson(`/fill/${token}/groups?${new URLSearchParams({ q: code })}`)
        .then((groups) => setMatches({ keyword: code, groups }))
        .catch(() => setMatches({ keyword: code, groups: [] }));
    }, 250);
    return () => clearTimeout(timer);
  }, [code, token]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const [year, month] = form.period.split('-').map(Number);
    try {
      const saved = await requestJson(`/fill/${token}/forecasts`, jsonBody('POST', {
        kind: form.kind, group_code: code, group_name: matched ? matched.group_name : form.group_name.trim(),
        product_type: form.product_type, year, month, line_count: Number(form.line_count), confidence: form.confidence
      }));
      setMade((current) => [saved, ...current]);
      setForm({ ...empty, kind: form.kind });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  const cancelled = form.kind === 'cancelled';
  return (
    <>
      <form className="fill-form fill-report" onSubmit={submit}>
        <div className="scope-actions" role="group" aria-label="上报类别">
          <button type="button" aria-pressed={!cancelled} onClick={() => setForm({ ...form, kind: 'added', confidence: '' })}>预计新增</button>
          <button type="button" aria-pressed={cancelled} onClick={() => setForm({ ...form, kind: 'cancelled', confidence: '' })}>预计销户</button>
        </div>
        <div className="fill-fields">
          <label>
            集团编码（可输入名称查找）
            <input list="fill-group-options" required autoComplete="off" value={form.group_code} disabled={busy} onChange={set('group_code')} />
            <datalist id="fill-group-options">
              {matches.groups.map((group) => <option key={group.group_code} value={group.group_code}>{group.group_name}</option>)}
            </datalist>
          </label>
          <label>
            集团名称
            <input required value={matched ? matched.group_name : form.group_name} readOnly={Boolean(matched)} disabled={busy} placeholder={matched ? '' : '系统里没有这个编码时请填写'} onChange={set('group_name')} />
          </label>
          <label>
            产品类型
            <select required value={form.product_type} disabled={busy} onChange={set('product_type')}>
              <option value="">选择产品类型</option>
              {report.productTypes.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label>
            预计月份
            <select required value={form.period} disabled={busy} onChange={set('period')}>
              <option value="">选择月份</option>
              {report.months.map((item) => <option key={`${item.year}-${item.month}`} value={`${item.year}-${item.month}`}>{item.year}年{item.month}月</option>)}
            </select>
          </label>
          <label>
            预计条数
            <input type="number" inputMode="numeric" required min={1} step={1} value={form.line_count} disabled={busy} onChange={set('line_count')} />
          </label>
          <label>
            把握度
            <select required value={form.confidence} disabled={busy} onChange={set('confidence')}>
              <option value="">选择把握度</option>
              {report.confidenceLevels.map((level) => <option key={level} value={level}>{confidenceName(form.kind, level)}</option>)}
            </select>
          </label>
        </div>
        <p className="fill-facts">这条{cancelled ? '预计销户' : '预计新增'}会记在 {manager} 名下。</p>
        {error && <p className="fill-error" role="alert">{error}</p>}
        <div className="fill-actions">
          <button type="submit" className="primary" disabled={busy}>{busy ? '正在提交…' : `上报${cancelled ? '预计销户' : '预计新增'}`}</button>
        </div>
      </form>
      {made.length > 0 && (
        <ul className="fill-made" aria-label="本次已上报">
          {made.map((item) => (
            <li key={item.id}><Check size={15} /> 已上报：{item.group_name} · {item.kind === 'cancelled' ? '预计销户' : '预计新增'} {item.line_count} 条 · {item.product_type} · {item.year}年{item.month}月</li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The page behind a fill link. No login: the token in the address is the whole key, and the
 * server shows and accepts only what that link covers.
 */
export default function FillPage({ token }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [tab, setTab] = useState(null);
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    document.title = '专线填报';
    requestJson(`/fill/${token}`)
      .then((data) => { setState({ loading: false, data, error: '' }); setTab(data.scopes[0]); })
      .catch((failure) => setState({ loading: false, data: null, error: failure.message }));
  }, [token]);

  const data = state.data;
  const lines = useMemo(() => {
    const word = keyword.trim().toLowerCase();
    return (data?.lines || []).filter((line) => !word || `${line.group_name} ${line.group_code} ${line.group_product_code} ${line.product_name} ${line.group_user_name || ''}`.toLowerCase().includes(word));
  }, [data, keyword]);

  if (state.loading) return <main className="fill-page"><p className="fill-state">正在打开…</p></main>;
  if (!data) {
    return (
      <main className="fill-page">
        <div className="fill-state" role="alert">
          <h1>无法打开填报页</h1>
          <p>{state.error}</p>
        </div>
      </main>
    );
  }

  const replaceLine = (line) => setState((current) => ({ ...current, data: { ...current.data, lines: current.data.lines.map((item) => (item.id === line.id ? line : item)) } }));
  const replaceForecast = (forecast) => setState((current) => ({ ...current, data: { ...current.data, forecasts: current.data.forecasts.map((item) => (item.id === forecast.id ? forecast : item)) } }));

  return (
    <main className="fill-page">
      <header className="fill-header">
        <p>专线台账管理系统</p>
        <h1>{data.manager} 的专线填报</h1>
        <p className="fill-meta">本页 {beijingTime(data.expiresAt)} 前有效 · 只显示你名下的内容 · 每次保存都会留下记录</p>
        {data.note && <p className="fill-note">{data.note}</p>}
      </header>

      {data.scopes.length > 1 && (
        <nav className="sub-tabs fill-tabs" aria-label="填报内容">
          {data.scopes.map((scope) => (
            <button key={scope} type="button" className={tab === scope ? 'active' : undefined} aria-current={tab === scope ? 'page' : undefined} onClick={() => setTab(scope)}>
              {data.scopeLabels[scope]}{scope === 'ledger' ? ` ${data.lines.length}` : scope === 'progress' ? ` ${data.forecasts.length}` : ''}
            </button>
          ))}
        </nav>
      )}

      {tab === 'ledger' && (
        <section aria-label="台账补充信息">
          <h2>台账补充信息 <span>{data.lines.length} 条在用专线</span></h2>
          {data.lines.length > 5 && (
            <label className="fill-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索专线" placeholder="集团名称、集团编码或集团产品编码" value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label>
          )}
          <ul className="fill-list">
            {lines.map((line) => <LineCard key={line.id} line={line} fields={data.fillFields} token={token} onSaved={replaceLine} />)}
          </ul>
          {!lines.length && <p className="fill-empty">{data.lines.length ? '没有符合搜索的专线' : '你名下目前没有在用专线'}</p>}
        </section>
      )}

      {tab === 'progress' && (
        <section aria-label="商机进度">
          <h2>商机进度 <span>{data.forecasts.length} 条</span></h2>
          <ul className="fill-list">
            {data.forecasts.map((forecast) => <ForecastCard key={forecast.id} forecast={forecast} token={token} onSaved={replaceForecast} />)}
          </ul>
          {!data.forecasts.length && <p className="fill-empty">你名下目前没有登记的商机{data.scopes.includes('report') ? '，可以在“商机上报”里登记' : ''}</p>}
        </section>
      )}

      {tab === 'report' && data.report && (
        <section aria-label="商机上报">
          <h2>商机上报</h2>
          <ReportForm report={data.report} token={token} manager={data.manager} />
        </section>
      )}
    </main>
  );
}
