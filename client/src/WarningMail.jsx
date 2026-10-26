import React, { useEffect, useRef, useState } from 'react';
import { Mail, Save, X } from 'lucide-react';

async function request(path, options = {}) {
  const response = await fetch(`/api/warnings${path}`, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '邮件操作失败');
  return value;
}
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const statusLabels = { preview: '已预览', sending: '发送中 / 待核实', queued: '已提交发送', failed: '发送失败', unknown: '状态待核实' };

export function WarningMailSettings({ onClose }) {
  const [contacts, setContacts] = useState(null);
  const [key, setKey] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([request('/mail/contacts'), request('/mail/status')]).then(([rows, value]) => {
      if (!active) return;
      setContacts(rows); setStatus(value); setKey(rows[0]?.key || ''); setEmail(rows[0]?.email || '');
    }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  async function save(event) {
    event.preventDefault(); setSaving(true); setNotice(''); setError('');
    try {
      const value = await request('/mail/contacts', { ...json({ key, email: email.trim() }), method: 'PUT' });
      setContacts((rows) => rows.map((row) => row.key === key ? { ...row, email: value.email } : row));
      setEmail(value.email); setNotice('客户经理邮箱已保存');
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  return <section className="warning-mail-settings" aria-label="客户经理邮箱设置">
    <div className="warning-mail-title"><h3>客户经理邮箱</h3><button title="关闭邮箱设置" onClick={onClose} disabled={saving}><X size={17} /></button></div>
    <p className="operations-rule">{status ? status.loggedIn ? 'Agent Mail 已授权' : 'Agent Mail 未授权，请在运行系统的设备上完成邮箱授权' : '正在检查邮箱授权…'}</p>
    <form className="warning-mail-contact-form" onSubmit={save}>
      <label>客户经理<select value={key} disabled={!contacts?.length || saving} onChange={(event) => { setKey(event.target.value); setEmail(contacts.find((row) => row.key === event.target.value)?.email || ''); setNotice(''); }}>
        {!contacts?.length && <option value="">{contacts ? '暂无客户经理' : '加载中…'}</option>}
        {contacts?.map((row) => <option key={row.key} value={row.key}>{row.name}{row.jobNo ? ` · ${row.jobNo}` : ''}{row.email ? ' · 已配置' : ''}</option>)}
      </select></label>
      <label>收件邮箱<input type="email" value={email} placeholder="manager@example.com" disabled={saving} onChange={(event) => setEmail(event.target.value)} /></label>
      <button disabled={!key || saving} type="submit"><Save size={16} />{saving ? '保存中' : '保存邮箱'}</button>
    </form>
    {error && <p className="operations-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}

export function WarningMailDialog({ row, asOf, kpiMode, onClose, onQueued, onConfigure }) {
  const dialog = useRef(null);
  const [preview, setPreview] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    dialog.current.showModal();
    const controller = new AbortController();
    request(`/${row.id}/reminder/preview`, { ...json({ asOf, kpiMode: kpiMode ? '1' : '0' }), signal: controller.signal }).then(setPreview).catch((err) => { if (err.name !== 'AbortError') setError(err.message); });
    request(`/${row.id}/mail-history`, { signal: controller.signal }).then(setHistory).catch((err) => { if (err.name !== 'AbortError') setHistoryError('发送记录读取失败'); });
    return () => controller.abort();
  }, [row.id, asOf, kpiMode]);
  async function send() {
    setSending(true); setAttempted(true); setError('');
    try {
      const result = await request(`/${row.id}/reminder`, json({ previewId: preview.id }));
      onQueued(row.id, result);
      onClose();
    } catch (err) { setError(`${err.message}。请查看发送记录后再操作。`); }
    finally { setSending(false); }
  }
  return <dialog ref={dialog} className="warning-mail-dialog" onCancel={(event) => { if (sending) event.preventDefault(); else onClose(); }} aria-labelledby="warning-mail-dialog-title">
    <div className="warning-mail-title"><h3 id="warning-mail-dialog-title">欠费预警报告</h3><button title="关闭报告" disabled={sending} onClick={onClose}><X size={18} /></button></div>
    {preview ? <><dl><dt>收件人</dt><dd>{preview.manager} &lt;{preview.recipient}&gt;</dd><dt>抄送</dt><dd>{preview.cc?.join('；') || '—'}</dd><dt>主题</dt><dd>{preview.subject}</dd></dl><pre className="warning-mail-body">{preview.body}</pre></> : !error && <p>正在生成报告…</p>}
    {error && <p className="operations-error" role="alert">{error}</p>}
    {history.length > 0 && <details className="warning-mail-history"><summary>最近发送记录</summary>{history.map((item) => <p key={item.id}>{new Date(item.sent_at || item.created_at).toLocaleString('zh-CN')} · {statusLabels[item.status] || item.status} · {item.recipient}{item.error ? ` · ${item.error}` : ''}</p>)}</details>}
    {historyError && <p role="alert">{historyError}</p>}
    <div className="warning-mail-footer"><button disabled={sending} onClick={onConfigure}>设置收件邮箱</button><button disabled={!preview || sending || attempted} onClick={send}><Mail size={16} />{sending ? '正在提交…' : '发送报告'}</button></div>
  </dialog>;
}
