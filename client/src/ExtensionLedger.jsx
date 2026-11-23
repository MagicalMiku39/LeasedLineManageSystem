import React, { useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { History, Mail, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { apiBase, isAbort, jsonBody, requestJson } from './api.js';
import { InlineError } from './components/Feedback.jsx';
import { beijingTime, money } from './utils.js';
import './operations.css';

const kindOptions = [
  { key: 'self', label: '自施工' },
  { key: 'supplier', label: '供应商安排' },
  { key: 'other', label: '其他单位（手动填写）' }
];
const emptyDraft = {
  group_code: '', group_name: '', manager_name: '', contract_amount: '', billing_amount: '', presale_amount: '',
  discount: '', profit_rate: '', deliverer: '', tiers: [], product_code: '', product_account: '', downstream_kind: '', downstream_name: '', remark: ''
};
const fieldLabels = {
  group_code: '集团编码', group_name: '集团名称', manager_name: '客户经理', deliverer: '交付商',
  contract_amount: '合同金额', billing_amount: '出账金额', presale_amount: '售前确认书金额', discount: '折扣', profit_rate: '移动侧利润',
  product_code: '产品编码', product_account: '产品账户', downstream_kind: '下游单位', downstream_name: '下游单位名称', tiers: '订购档次', remark: '备注', record: '整条记录'
};
const sourceLabels = { mail: '邮件', paste: '粘贴正文', manual: '手动' };
const yuan = (value) => (value === null || value === undefined || value === '' ? '—' : money(value));
const asForm = (row) => Object.fromEntries(Object.keys(emptyDraft).map((key) => [key, key === 'tiers'
  ? (row.tiers || []).map((tier) => ({ name: tier.name, price: String(tier.price ?? ''), times: String(tier.times ?? '') }))
  : row[key] === null || row[key] === undefined ? '' : String(row[key])]));

// The record's fields, as checked before saving or when filling in later.
function RecordForm({ form, setForm, disabled }) {
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const tierTotal = form.tiers.reduce((sum, tier) => sum + (Number(tier.price) || 0) * (Number(tier.times) || 0), 0);
  const setTier = (index, key, value) => setForm({ ...form, tiers: form.tiers.map((tier, at) => (at === index ? { ...tier, [key]: value } : tier)) });
  const field = (key, extra = {}) => (
    <label key={key} className={extra.wide ? 'kpi-edit-wide' : undefined}>
      {fieldLabels[key]}{extra.unit ? `（${extra.unit}）` : ''}
      <input
        value={form[key]}
        disabled={disabled}
        inputMode={extra.numeric ? 'decimal' : undefined}
        placeholder={extra.placeholder}
        maxLength={200}
        onChange={set(key)}
      />
    </label>
  );
  return (
    <>
      <h4 className="ext-form-title">邮件中的信息</h4>
      <div className="kpi-edit-fields ext-fields">
        {field('group_name', { wide: true })}
        {field('group_code')}
        {field('manager_name')}
        {field('contract_amount', { numeric: true, unit: '元' })}
        {field('billing_amount', { numeric: true, unit: '元' })}
        {field('presale_amount', { numeric: true, unit: '元' })}
        {field('deliverer', { placeholder: '例如 铁通' })}
        {field('discount', { numeric: true, unit: '%' })}
        {field('profit_rate', { numeric: true, unit: '%' })}
      </div>
      <div className="ext-tiers">
        <div className="ext-tiers-head">
          <span>订购资费档次</span>
          <button type="button" className="text-button" disabled={disabled || form.tiers.length >= 20} onClick={() => setForm({ ...form, tiers: [...form.tiers, { name: '', price: '', times: '' }] })}><Plus size={13} /> 添加档次</button>
        </div>
        {form.tiers.map((tier, index) => (
          <div key={index} className="ext-tier">
            <input aria-label="档次名称" placeholder="档次名称" value={tier.name} disabled={disabled} maxLength={60} onChange={(event) => setTier(index, 'name', event.target.value)} />
            <input aria-label="单价（元/次）" placeholder="元/次" inputMode="decimal" value={tier.price} disabled={disabled} onChange={(event) => setTier(index, 'price', event.target.value)} />
            <input aria-label="次数" placeholder="次数" inputMode="numeric" value={tier.times} disabled={disabled} onChange={(event) => setTier(index, 'times', event.target.value)} />
            <span className="ext-tier-sum">{money((Number(tier.price) || 0) * (Number(tier.times) || 0))}</span>
            <button type="button" aria-label="删除这个档次" title="删除这个档次" disabled={disabled} onClick={() => setForm({ ...form, tiers: form.tiers.filter((_, at) => at !== index) })}><X size={14} /></button>
          </div>
        ))}
        {form.tiers.length > 0
          ? <p className="subtle ext-tier-total">合计 {money(tierTotal)} 元{form.discount !== '' && Number(form.discount) !== 100 ? `，折扣 ${form.discount}% 后 ${money(tierTotal * (Number(form.discount) || 0) / 100)} 元` : ''}</p>
          : <p className="subtle ext-tier-total">没有档次</p>}
      </div>
      <h4 className="ext-form-title">待补充</h4>
      <div className="kpi-edit-fields ext-fields">
        {field('product_code', { placeholder: '集团产品编码，如 2705404918972' })}
        {field('product_account')}
        <label className="kpi-edit-wide">
          下游单位
          <select value={form.downstream_kind} disabled={disabled} onChange={set('downstream_kind')}>
            <option value="">未填写</option>
            {kindOptions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
        </label>
        {form.downstream_kind === 'other' && field('downstream_name', { wide: true, placeholder: '下游单位名称' })}
        <label className="kpi-edit-wide">
          备注
          <textarea rows={2} maxLength={200} value={form.remark} disabled={disabled} onChange={set('remark')} />
        </label>
      </div>
    </>
  );
}

const payload = (form) => ({
  ...form,
  tiers: form.tiers.filter((tier) => tier.name || tier.price || tier.times).map((tier) => ({ name: tier.name.trim(), price: tier.price, times: Number(tier.times) }))
});

// Reading a filing mail (from the agent mailbox, or pasted) into a record, checked before it is saved.
function ImportDialog({ onClose, onSaved }) {
  const [mode, setMode] = useState('mail');
  const [query, setQuery] = useState('专线延伸');
  const [mails, setMails] = useState({ loading: true, list: [], hidden: { imported: 0, skipped: 0 }, error: '' });
  const [showHandled, setShowHandled] = useState(false);
  const [pasted, setPasted] = useState('');
  const [result, setResult] = useState(null);
  const [form, setForm] = useState(emptyDraft);
  const [confirmRepeat, setConfirmRepeat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load(q = query, all = showHandled) {
    setMails((current) => ({ ...current, loading: true, error: '' }));
    requestJson(`/extensions/mail?${new URLSearchParams({ q, ...(all ? { all: '1' } : {}) })}`)
      .then((data) => setMails({ loading: false, list: data.messages, hidden: data.hidden || { imported: 0, skipped: 0 }, error: '' }))
      .catch((failure) => setMails({ loading: false, list: [], hidden: { imported: 0, skipped: 0 }, error: failure.message }));
  }
  useEffect(() => { load(); }, []);

  function take(data, source) {
    setResult({ ...data, source });
    setForm({ ...emptyDraft, ...asForm({ ...data.draft }) });
    setConfirmRepeat(false);
    setError('');
  }

  // Setting a mail aside so it is no longer listed (the mailbox itself is left as it is), or undoing that.
  async function skipMail(item, reason) {
    setBusy(true);
    setError('');
    try {
      if (reason) await requestJson(`/extensions/mail/${encodeURIComponent(item.id)}/skip`, jsonBody('POST', { reason, subject: item.subject }));
      else await requestJson(`/extensions/mail/${encodeURIComponent(item.id)}/skip`, { method: 'DELETE' });
      if (result) setResult(null);
      load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function readMail(id) {
    setBusy(true);
    setError('');
    try {
      take(await requestJson(`/extensions/mail/${encodeURIComponent(id)}/parse`, { method: 'POST' }), 'mail');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function readPasted() {
    setBusy(true);
    setError('');
    try {
      take(await requestJson('/extensions/parse', jsonBody('POST', { text: pasted })), 'paste');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await requestJson('/extensions', jsonBody('POST', { ...payload(form), source: result.source, mail: result.mail, text: result.text, confirmRepeat }));
      onSaved();
    } catch (failure) {
      // A repeat found only on saving (the figures were edited to match one) asks for the same confirmation.
      if (failure.data?.repeat && !result.repeats?.length) setResult({ ...result, repeats: [failure.message] });
      else setError(failure.message);
      setBusy(false);
    }
  }
  const mustConfirm = Boolean(result?.repeats?.length) && !confirmRepeat;

  return (
    <div className="modal-mask" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onClose(); }}>
      <div className="modal kpi-progress-dialog ext-dialog" role="dialog" aria-modal="true" aria-label="录入专线延伸项目">
        <header className="kpi-progress-head">
          <h3>录入专线延伸项目</h3>
          <button type="button" className="kpi-progress-close" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}><X size={16} /></button>
        </header>
        <div className="kpi-progress-body">
          {!result ? (
            <>
              <div className="scope-actions" role="group" aria-label="录入方式">
                <button type="button" aria-pressed={mode === 'mail'} onClick={() => setMode('mail')}><Mail size={14} /> 从邮箱收取</button>
                <button type="button" aria-pressed={mode === 'paste'} onClick={() => setMode('paste')}>粘贴邮件正文</button>
              </div>
              {mode === 'mail' ? (
                <>
                  <form className="ext-mail-search" onSubmit={(event) => { event.preventDefault(); load(); }}>
                    <label className="kpi-list-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索邮件" value={query} maxLength={40} onChange={(event) => setQuery(event.target.value)} /></label>
                    <button type="submit" disabled={mails.loading}>搜索</button>
                  </form>
                  <p className="subtle ext-note">在系统邮箱的收件箱中按主题和正文搜索，只读取，不会改动或删除邮件。已录入和标为不录入的邮件不再列出。</p>
                  <InlineError message={mails.error} onRetry={() => load()} />
                  {mails.loading && <p className="subtle" role="status">正在读取邮箱…</p>}
                  {!mails.loading && !mails.error && !mails.list.length && (
                    <p className="subtle">{mails.hidden.imported + mails.hidden.skipped ? '没有待录入的邮件。' : '收件箱中没有找到相关邮件。'}</p>
                  )}
                  <ul className="ext-mail-list">
                    {mails.list.map((item) => {
                      const handled = item.importedId || item.skipped;
                      return (
                        <li key={item.id} className={handled ? 'ext-mail-handled' : undefined}>
                          <button type="button" disabled={busy} onClick={() => readMail(item.id)}>
                            <strong>{item.subject || '（无主题）'}</strong>
                            <small>
                              {item.from}{item.at ? ` · ${beijingTime(item.at)}` : ''}
                              {item.importedId ? ` · 已录入${item.importedName ? `（${item.importedName}）` : ''}` : ''}
                              {!item.importedId && item.skipped ? ` · 已标为不录入（${item.skipped.reason}）` : ''}
                            </small>
                            {item.repeats?.map((note) => <small key={note} className="ext-repeat">{note}</small>)}
                            {item.snippet && <small className="ext-snippet">{item.snippet}</small>}
                          </button>
                          {!item.importedId && (
                            <button
                              type="button"
                              className="text-button ext-mail-skip"
                              disabled={busy}
                              onClick={() => skipMail(item, item.skipped ? null : item.repeats?.length ? '重复邮件' : '无需录入')}
                            >
                              {item.skipped ? '恢复' : item.repeats?.length ? '标为重复，不再显示' : '不录入，不再显示'}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {(mails.hidden.imported + mails.hidden.skipped > 0 || showHandled) && !mails.loading && (
                    <button
                      type="button"
                      className="text-button ext-mail-toggle"
                      onClick={() => { const next = !showHandled; setShowHandled(next); load(query, next); }}
                    >
                      {showHandled ? '只看待录入的邮件' : `显示已处理的邮件（已录入 ${mails.hidden.imported} 封、不录入 ${mails.hidden.skipped} 封）`}
                    </button>
                  )}
                </>
              ) : (
                <div className="kpi-edit-fields">
                  <label className="kpi-edit-wide">
                    邮件正文
                    <textarea rows={9} value={pasted} maxLength={20000} placeholder="把邮件正文整段粘贴到这里" onChange={(event) => setPasted(event.target.value)} />
                  </label>
                  <div className="kpi-form-actions kpi-edit-wide">
                    <button type="button" className="primary" disabled={busy || !pasted.trim()} onClick={readPasted}>{busy ? '正在识别…' : '识别'}</button>
                  </div>
                </div>
              )}
              <InlineError message={error} />
            </>
          ) : (
            <form onSubmit={save}>
              {result.mail && (
                <p className="subtle ext-note">
                  来自邮件：{result.mail.subject || '（无主题）'} · {result.mail.from}{result.mail.at ? ` · ${beijingTime(result.mail.at)}` : ''}
                  {result.mail.attachments?.length ? ` · 附件：${result.mail.attachments.join('、')}` : ''}
                </p>
              )}
              {result.importedId && <p className="operations-error">这封邮件已经录入过，不能重复录入。</p>}
              {result.skipped && <p className="ext-warn">这封邮件已标为不录入（{result.skipped.reason}）。仍要录入的话可以继续。</p>}
              {!result.importedId && result.repeats?.length > 0 && (
                <div className="ext-repeats" role="alert">
                  <strong>可能是重复的项目</strong>
                  {result.repeats.map((note) => <p key={note}>{note}</p>)}
                  <label className="ext-check">
                    <input type="checkbox" checked={confirmRepeat} disabled={busy} onChange={(event) => setConfirmRepeat(event.target.checked)} /> 不是重复，仍然录入
                  </label>
                  {result.mail && !result.skipped && (
                    <button type="button" className="text-button" disabled={busy} onClick={() => skipMail(result.mail, '重复邮件')}>是重复的，标为重复并返回</button>
                  )}
                </div>
              )}
              {result.missing.length > 0 && <p className="ext-warn">没有识别到：{result.missing.join('、')}，请对照正文补上。</p>}
              {result.warnings.map((warning) => <p key={warning} className="ext-warn">{warning}</p>)}
              <details className="ext-source"><summary>查看邮件正文</summary><pre>{result.text}</pre></details>
              <RecordForm form={form} setForm={setForm} disabled={busy} />
              <InlineError message={error} />
              <div className="kpi-form-actions">
                <button type="button" disabled={busy} onClick={() => { setResult(null); setError(''); }}>返回</button>
                <button type="submit" className="primary" disabled={busy || Boolean(result.importedId) || mustConfirm}>{busy ? '正在保存…' : '确认录入'}</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function EditDialog({ row, onClose, onSaved }) {
  const [form, setForm] = useState(() => asForm(row));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);
  useEffect(() => {
    const controller = new AbortController();
    requestJson(`/extensions/${row.id}/log`, { signal: controller.signal }).then(setHistory).catch((failure) => { if (!isAbort(failure)) setHistory([]); });
    return () => controller.abort();
  }, [row.id]);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await requestJson(`/extensions/${row.id}`, jsonBody('PATCH', payload(form)));
      onSaved();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onClose(); }}>
      <form className="modal kpi-progress-dialog ext-dialog" role="dialog" aria-modal="true" aria-label="编辑专线延伸项目" onSubmit={save}>
        <header className="kpi-progress-head">
          <h3>{row.group_name || row.group_code}</h3>
          <button type="button" className="kpi-progress-close" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}><X size={16} /></button>
        </header>
        <div className="kpi-progress-body">
          {row.line && <p className="subtle ext-note">产品编码对应台账专线：{row.line.group_user_name || row.line.product_name} · {row.line.status}{row.line.group_product_account_id ? ` · 台账产品账户 ${row.line.group_product_account_id}` : ''}</p>}
          <RecordForm form={form} setForm={setForm} disabled={busy} />
          <InlineError message={error} />
          <div className="kpi-form-actions">
            <button type="button" disabled={busy} onClick={onClose}>取消</button>
            <button type="submit" className="primary" disabled={busy}>{busy ? '正在保存…' : '保存'}</button>
          </div>
          {history.length > 0 && (
            <details className="ext-source">
              <summary><History size={13} /> 修改记录（{history.length}）</summary>
              <ul className="ext-history">
                {history.map((entry) => (
                  <li key={entry.id}>
                    {beijingTime(entry.changed_at)} · {entry.changed_by || '—'} · {entry.action === 'edit' ? `${fieldLabels[entry.field_name] || entry.field_name}：${entry.old_value ?? '空'} → ${entry.new_value ?? '空'}` : entry.action}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </form>
    </div>
  );
}

/**
 * 专线延伸台账: extension-service projects, entered from their filing mails. The figures come
 * from the mail; the product code, product account and downstream unit are filled in later.
 */
export default function ExtensionLedger({ ref, refreshToken, tabs }) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [keyword, setKeyword] = useState('');
  const [manager, setManager] = useState('');
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [error, setError] = useState('');
  const reload = () => setRevision((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));
    requestJson('/extensions', { signal: controller.signal })
      .then((data) => setState({ loading: false, data, error: '' }))
      .catch((failure) => { if (!isAbort(failure)) setState({ loading: false, data: null, error: failure.message }); });
    return () => controller.abort();
  }, [revision, refreshToken]);

  const data = state.data;
  const filtered = Boolean(keyword.trim() || manager || onlyIncomplete);
  const rows = useMemo(() => {
    const words = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.rows || []).filter((row) => (!manager || row.manager_name === manager)
      && (!onlyIncomplete || row.missing.length)
      && words.every((word) => `${row.group_name || ''} ${row.group_code || ''} ${row.manager_name || ''} ${row.deliverer || ''} ${row.product_code || ''} ${row.downstream || ''}`.toLowerCase().includes(word)));
  }, [data, keyword, manager, onlyIncomplete]);

  // The export follows what is on screen: with a filter on, only the rows shown.
  useImperativeHandle(ref, () => ({
    refresh: reload,
    openImport: () => setImporting(true),
    exportData: () => {
      const only = filtered ? `?ids=${rows.map((row) => row.id).join(',')}` : '';
      window.location.href = `${apiBase}/extensions/export/xlsx${only}`;
    }
  }), [filtered, rows]);

  async function remove(row) {
    setError('');
    try {
      await requestJson(`/extensions/${row.id}`, { method: 'DELETE' });
      setConfirmDelete(null);
      reload();
    } catch (failure) {
      setError(failure.message);
    }
  }

  return (
    <main className="page ext-page">
      {tabs}
      <section className="operations-heading">
        <div>
          <h2>专线延伸台账</h2>
          <p className="operations-rule">从专线延伸建档邮件录入：集团、客户经理、金额、档次和交付商从邮件中识别，核对后保存；产品编码、产品账户和下游单位之后补充。点顶部“邮件录入”或“录入项目”按钮开始。</p>
        </div>
        <button type="button" className="primary" onClick={() => setImporting(true)}><Mail size={16} /> 录入项目</button>
      </section>
      {state.error && <p role="alert" className="operations-error">{state.error}</p>}
      {error && <p role="alert" className="operations-error">{error}</p>}
      {data && (
        <section className="operations-summary" aria-label="延伸台账概览">
          <div><span>项目</span><strong>{data.summary.count}</strong></div>
          <div><span>合同金额（元）</span><strong>{money(data.summary.contract)}</strong></div>
          <div><span>出账金额（元）</span><strong>{money(data.summary.billing)}</strong></div>
          <div><span>待补充</span><strong className={data.summary.incomplete ? 'operations-remind' : undefined}>{data.summary.incomplete}</strong></div>
        </section>
      )}
      <div className="operations-filters">
        <label className="operations-search"><Search size={17} /><input aria-label="搜索延伸台账" placeholder="集团、编码、客户经理、交付商或产品编码" value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label>
        <label>客户经理<select value={manager} onChange={(event) => setManager(event.target.value)}><option value="">全部</option>{(data?.managers || []).map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label className="ext-check"><input type="checkbox" checked={onlyIncomplete} onChange={(event) => setOnlyIncomplete(event.target.checked)} /> 只看待补充</label>
        <span>{state.loading ? '加载中' : `${rows.length} 条`}</span>
      </div>
      <div className="operations-table-wrap">
        <table className="warning-table ext-table">
          <thead><tr><th>集团</th><th>客户经理</th><th className="num">合同 / 出账</th><th className="num">售前确认书</th><th>交付商 · 档次</th><th>产品编码 / 账户</th><th>下游单位</th><th>录入</th><th className="operations-actions-cell">操作</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="operations-group-cell"><strong className="ext-name">{row.group_name || '—'}</strong><small>{row.group_code || '—'}</small></td>
                <td>{row.manager_name || '—'}</td>
                <td className="num operations-stack-cell">{yuan(row.contract_amount)}<small>出账 {yuan(row.billing_amount)}</small></td>
                <td className="num">{yuan(row.presale_amount)}</td>
                <td className="operations-stack-cell ext-wrap">{row.deliverer || '—'}<small>{row.tiers.length ? row.tiers.map((tier) => `${tier.name.replace(/^数据专线延伸服务/, '')} ${tier.price}×${tier.times}`).join('，') : '无档次'}</small></td>
                <td className="operations-stack-cell">{row.product_code || <span className="ext-missing">待填写</span>}<small>{row.product_account || '账户待填写'}</small></td>
                <td>{row.downstream || <span className="ext-missing">待填写</span>}</td>
                <td className="operations-stack-cell">{sourceLabels[row.source]}<small>{beijingTime(row.created_at).slice(0, 10)}</small></td>
                <td className="operations-actions-cell">
                  <div className="operations-row-actions">
                    <button type="button" onClick={() => setEditing(row)}><Pencil size={14} />{row.missing.length ? '补充' : '编辑'}</button>
                    {confirmDelete === row.id
                      ? <button type="button" className="kpi-danger" onClick={() => remove(row)}>确认删除</button>
                      : <button type="button" aria-label="删除" title="删除" onClick={() => setConfirmDelete(row.id)}><Trash2 size={14} /></button>}
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="9" className="empty">{state.loading ? '正在加载…' : data?.rows.length ? '没有符合条件的项目' : '还没有专线延伸项目，点“录入项目”从邮件录入'}</td></tr>}
          </tbody>
        </table>
      </div>
      {importing && <ImportDialog onClose={() => setImporting(false)} onSaved={() => { setImporting(false); reload(); }} />}
      {editing && <EditDialog row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </main>
  );
}
