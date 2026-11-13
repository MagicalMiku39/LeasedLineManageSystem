import React, { useEffect, useImperativeHandle, useState } from 'react';
import { Ban, Copy, Link2, Mail } from 'lucide-react';
import { isAbort, jsonBody, requestJson } from './api.js';
import { defaultManagers } from './ledger/config.js';
import { beijingTime } from './utils.js';

const dayChoices = [1, 3, 7, 14, 30];
const stateLabels = { active: '有效', expired: '已过期', revoked: '已作废' };
const kindLabels = { ledger: '台账补充信息', progress: '商机进度', report: '商机上报' };

/**
 * 填报链接: makes a link one manager can open without an account to fill in their own lines'
 * hand-kept fields, their forecasts' progress, or a new forecast, until it expires or is
 * revoked. The link is shown once; what was written through it is listed below.
 */
export default function ShareLinks({ ref, refreshToken }) {
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ manager: '', scopes: ['ledger', 'progress', 'report'], days: 3, note: '' });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [made, setMade] = useState(null);
  const [copied, setCopied] = useState(false);
  const [only, setOnly] = useState(null);
  // 批量: one link per chosen manager, each mailed to that manager's own address.
  const [mode, setMode] = useState('single');
  const [picked, setPicked] = useState(() => new Set());
  const [results, setResults] = useState({});
  const [sending, setSending] = useState(false);
  const reload = () => setRevision((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    Promise.all([
      requestJson('/share-links', { signal: controller.signal }),
      requestJson(`/share-links/submissions${only ? `?link=${only.id}` : ''}`, { signal: controller.signal })
    ]).then(([links, rows]) => { setData(links); setSubmissions(rows); })
      .catch((failure) => { if (!isAbort(failure)) setError(`填报链接读取失败：${failure.message}`); });
    return () => controller.abort();
  }, [revision, refreshToken, only]);

  useImperativeHandle(ref, () => ({
    refresh: reload,
    exportData: async () => {
      if (!submissions.length) return;
      const module = await import('xlsx');
      const XLSX = module.default || module;
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(submissions.map((row) => ({
        时间: beijingTime(row.at), 客户经理: row.manager_name, 类别: kindLabels[row.kind] || row.kind, 内容: row.summary, 来源: (row.source || '').replace(/^ip:/, '')
      }))), '填报记录');
      XLSX.writeFile(book, '填报记录.xlsx');
    }
  }), [submissions]);

  const managers = data ? [...new Set([...defaultManagers.filter((name) => data.managers.includes(name)), ...data.managers])] : [];
  // While the fill port is on, links start with its public address.
  const linkBase = data?.linkBase || window.location.origin;
  const outside = Boolean(data?.linkBase);
  const url = made ? `${linkBase}${made.path}` : '';

  function toggleScope(key) {
    setForm((current) => ({ ...current, scopes: current.scopes.includes(key) ? current.scopes.filter((item) => item !== key) : [...current.scopes, key] }));
  }

  async function create(event) {
    event.preventDefault();
    setFormError('');
    if (!form.manager) return setFormError('请选择客户经理');
    if (!form.scopes.length) return setFormError('请至少选择一项填报内容');
    setBusy(true);
    try {
      setMade(await requestJson('/share-links', jsonBody('POST', form)));
      setCopied(false);
      setForm((current) => ({ ...current, note: '' }));
      reload();
    } catch (failure) {
      setFormError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  const emails = data?.emails || {};
  const chosen = managers.filter((name) => picked.has(name) && emails[name]);

  function pick(names) {
    setPicked(new Set(names.filter((name) => emails[name])));
    setResults({});
  }

  function togglePick(name) {
    const next = new Set(picked);
    if (next.has(name)) next.delete(name); else next.add(name);
    setPicked(next);
  }

  // One manager after another, so a failure names its manager and the rest still go out.
  async function sendBatch(event) {
    event.preventDefault();
    setFormError('');
    if (!form.scopes.length) return setFormError('请至少选择一项填报内容');
    if (!chosen.length) return setFormError('请勾选至少一位已设置邮箱的客户经理');
    setSending(true);
    setMade(null);
    const todo = chosen.filter((name) => results[name]?.state !== 'sent');
    for (const name of todo) {
      setResults((current) => ({ ...current, [name]: { state: 'sending' } }));
      try {
        const result = await requestJson('/share-links/send', jsonBody('POST', { manager: name, scopes: form.scopes, days: form.days, note: form.note, origin: window.location.origin }));
        setResults((current) => ({ ...current, [name]: { state: 'sent', message: `已发送至 ${result.recipient}` } }));
      } catch (failure) {
        setResults((current) => ({ ...current, [name]: { state: 'failed', message: failure.message } }));
      }
    }
    setSending(false);
    reload();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
      setFormError('复制没有成功，请长按或手动选中链接复制');
    }
  }

  async function revoke(link) {
    try {
      await requestJson(`/share-links/${link.id}/revoke`, { method: 'POST' });
      if (made?.id === link.id) setMade(null);
      reload();
    } catch (failure) {
      setError(`作废失败：${failure.message}`);
    }
  }

  return (
    <div className="share-page">
      <section className="operations-heading">
        <div>
          <h2>填报链接</h2>
          <p className="operations-rule">给一位客户经理生成专属链接。对方不用登录，只能看到并填写自己名下的内容；到期或作废后链接失效，每次填写都有记录。</p>
        </div>
      </section>
      {error && <p role="alert" className="operations-error">{error}</p>}

      <section className="kpi-panel share-create">
        <div className="share-create-head">
          <h3>生成链接</h3>
          <div className="scope-actions" role="group" aria-label="生成方式">
            <button type="button" aria-pressed={mode === 'single'} disabled={sending} onClick={() => { setMode('single'); setFormError(''); }}><Link2 size={15} /> 单个生成</button>
            <button type="button" aria-pressed={mode === 'batch'} disabled={sending} onClick={() => { setMode('batch'); setFormError(''); setMade(null); }}><Mail size={15} /> 批量生成并邮件发送</button>
          </div>
        </div>
        <form onSubmit={mode === 'batch' ? sendBatch : create}>
          {mode === 'batch' && (
            <fieldset className="share-batch" disabled={sending}>
              <legend>客户经理（每人一条专属链接，发到各自的邮箱）</legend>
              <div className="share-batch-tools">
                <button type="button" onClick={() => pick(defaultManagers)}>选指定 18 位</button>
                <button type="button" onClick={() => pick(managers)}>选全部有邮箱的</button>
                <button type="button" onClick={() => pick([])}>清空</button>
                <span className="operations-rule">已选 {chosen.length} 位 · 邮箱在“欠费销户预警 → 客户经理邮箱”中设置</span>
              </div>
              <ul className="share-batch-list">
                {managers.map((name) => {
                  const result = results[name];
                  return (
                    <li key={name}>
                      <label>
                        <input type="checkbox" disabled={!emails[name]} checked={picked.has(name) && Boolean(emails[name])} onChange={() => togglePick(name)} />
                        <span>
                          <strong>{name}</strong>
                          <small>{emails[name] || '未设置邮箱，不能发送'}</small>
                          {result && <small className={result.state === 'failed' ? 'operations-error' : result.state === 'sent' ? 'operations-level-green' : ''} role={result.state === 'failed' ? 'alert' : 'status'}>{result.state === 'sending' ? '正在发送…' : result.message}</small>}
                        </span>
                      </label>
                    </li>
                  );
                })}
                {data && !managers.length && <li className="operations-rule">台账中还没有客户经理</li>}
              </ul>
            </fieldset>
          )}
          <div className="share-form">
            {mode === 'single' && (
              <label>
                客户经理
                <select value={form.manager} onChange={(event) => setForm({ ...form, manager: event.target.value })} required>
                  <option value="">选择客户经理</option>
                  {managers.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
            )}
            <label>
              有效期
              <select value={form.days} onChange={(event) => setForm({ ...form, days: Number(event.target.value) })}>
                {dayChoices.map((days) => <option key={days} value={days}>{days} 天</option>)}
              </select>
            </label>
            <label className="share-form-wide">
              给对方的说明（选填，显示在填报页顶部）
              <input maxLength={200} value={form.note} placeholder="例如：请在周五前补全合同信息" onChange={(event) => setForm({ ...form, note: event.target.value })} />
            </label>
          </div>
          <fieldset className="share-scopes">
            <legend>可填写的内容</legend>
            {(data?.scopes || []).map((scope) => (
              <label key={scope.key}>
                <input type="checkbox" checked={form.scopes.includes(scope.key)} onChange={() => toggleScope(scope.key)} />
                <span>
                  <strong>{scope.label}</strong>
                  <small>{{ ledger: '名下在用专线的实际月资费、合同、续约、联系人、项目名称、备注', progress: '名下 KPI 预计任务的进展说明和已落地条数', report: '登记新的预计新增或预计销户，记在这位客户经理名下' }[scope.key]}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {mode === 'batch' && <p className="operations-rule share-batch-note">点击后立即发送真实邮件：每位客户经理收到一封只含自己链接的邮件，不抄送其他人。{outside ? `邮件里的链接以对外填报地址 ${linkBase} 开头，对方在外网也能打开。` : `填报端口没有开启，邮件里的链接地址是你现在打开系统用的地址（${linkBase}），对方需要在能打开这个地址的网络内使用。`}</p>}
          {formError && <p role="alert" className="operations-error">{formError}</p>}
          <div className="kpi-form-actions">
            {mode === 'batch'
              ? <button type="submit" className="primary" disabled={sending || !data || !chosen.length}><Mail size={16} /> {sending ? '正在发送…' : `生成并发送给 ${chosen.length} 位客户经理`}</button>
              : <button type="submit" className="primary" disabled={busy || !data}><Link2 size={16} /> {busy ? '正在生成…' : '生成链接'}</button>}
          </div>
        </form>

        {made && (
          <div className="share-made" role="status">
            <strong>{made.manager} 的填报链接已生成，{beijingTime(made.expiresAt)} 前有效</strong>
            <div className="share-url">
              <input readOnly aria-label="填报链接" value={url} onFocus={(event) => event.target.select()} />
              <button type="button" onClick={copy}><Copy size={15} /> {copied ? '已复制' : '复制链接'}</button>
            </div>
            <p className="operations-rule">链接只在这里显示这一次，系统不保存链接本身，离开页面后无法再查看；丢失了请作废后重新生成。拿到链接的人都能填写，请只发给本人。{outside ? '填报端口已开启，对方在外网也能打开。' : '填报端口没有开启，对方需要在能打开本系统的网络内使用；要让外网也能打开，请到“设置 → 访问控制 → 填报端口”开启。'}</p>
          </div>
        )}
      </section>

      <section className="kpi-panel kpi-wide">
        <h3>已生成的链接 <span className="share-count">{data?.links.length ?? 0}</span></h3>
        <div className="table-scroll">
          <table className="data-table share-table">
            <thead><tr><th>客户经理</th><th>可填写</th><th>状态</th><th>到期时间</th><th className="num">打开</th><th className="num">提交</th><th>最近提交</th><th>邮件发送</th><th>说明</th><th>操作</th></tr></thead>
            <tbody>
              {(data?.links || []).map((link) => (
                <tr key={link.id} className={link.state === 'active' ? undefined : 'share-over'}>
                  <td>{link.manager}</td>
                  <td className="share-wrap">{link.scopes.map((key) => kindLabels[key]).join('、')}</td>
                  <td><span className={`status-pill share-state-${link.state}`}>{stateLabels[link.state]}</span></td>
                  <td>{beijingTime(link.expiresAt)}</td>
                  <td className="num">{link.openCount}{link.sourceCount > 1 && <small className={`share-sources${link.sourceCount > 3 ? ' operations-error' : ''}`} title="打开过这条链接的不同地址数量；手机换网络会增加，数量多时请留意链接是否被转发">{link.sourceCount} 个地址</small>}</td>
                  <td className="num">{link.submitCount}</td>
                  <td>{link.lastUsedAt ? beijingTime(link.lastUsedAt) : '—'}</td>
                  <td className="share-wrap">{link.sentTo ? `${link.sentTo}（${beijingTime(link.sentAt)}）` : '—'}</td>
                  <td className="share-wrap">{link.note || '—'}</td>
                  <td>
                    <div className="operations-row-actions">
                      <button type="button" aria-pressed={only?.id === link.id} onClick={() => setOnly(only?.id === link.id ? null : link)}>填报记录</button>
                      {link.state === 'active' && <button type="button" onClick={() => revoke(link)}><Ban size={14} />作废</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {data && !data.links.length && <tr className="state-row"><td colSpan="10" className="empty">还没有生成过链接</td></tr>}
              {!data && !error && <tr className="state-row"><td colSpan="10" className="empty">正在读取…</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="kpi-panel kpi-wide">
        <h3>填报记录 <span className="share-count">{submissions.length}</span></h3>
        <p className="operations-rule share-log-note">
          {only ? `只看 ${only.manager} 的这条链接。` : '最近 200 条，全部链接。'}
          {only && <button type="button" className="text-button" onClick={() => setOnly(null)}>查看全部</button>}
          台账的改动同时记在专线详情的修改记录里，商机进展记在该商机的进展里。
        </p>
        <div className="table-scroll">
          <table className="data-table share-table">
            <thead><tr><th>时间</th><th>客户经理</th><th>类别</th><th>内容</th><th>来源</th></tr></thead>
            <tbody>
              {submissions.map((row) => (
                <tr key={row.id}>
                  <td>{beijingTime(row.at)}</td>
                  <td>{row.manager_name}</td>
                  <td>{kindLabels[row.kind] || row.kind}</td>
                  <td className="share-wrap share-summary">{row.summary}</td>
                  <td>{(row.source || '—').replace(/^ip:/, '').replace(/^::ffff:/, '')}</td>
                </tr>
              ))}
              {!submissions.length && <tr className="state-row"><td colSpan="5" className="empty">还没有通过链接提交的内容</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
