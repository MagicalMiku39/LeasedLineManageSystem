import React, { useEffect, useState } from 'react';
import { Copy, DatabaseBackup, Download, FilePlus2, History, KeyRound, ScrollText, ShieldCheck, ShieldOff } from 'lucide-react';
import { apiBase, isAbort, jsonBody, requestJson } from './api.js';
import { InlineError } from './components/Feedback.jsx';
import { describeSource, isAlertEvent, securityEventLabels, securityLogCategories } from './securityLog.js';
import { beijingTime } from './utils.js';
import './settings.css';

const certPath = '/settings/client-certs';
const categoryStorageKey = 'ledger-settings-category';

// The settings page's left-hand menu; each entry shows only its own sections.
const settingsCategories = [
  { key: 'access', label: '访问控制', icon: KeyRound, description: '设备证书：让 IP 不固定的手机安全访问系统，不用逐个开放 IP 白名单。' },
  { key: 'backup', label: '备份与恢复', icon: DatabaseBackup, description: '导入前和每周自动备份整个数据库；导错文件时回退台账类数据或战客清单，回退也可以撤销。' },
  { key: 'log', label: '安全日志', icon: ScrollText, description: '登录、设置页验证码、证书和端口、备份下载与回退的操作记录。' }
];

function savedCategory() {
  try {
    const saved = localStorage.getItem(categoryStorageKey);
    return settingsCategories.some((item) => item.key === saved) ? saved : settingsCategories[0].key;
  } catch {
    return settingsCategories[0].key;
  }
}
const stateLabels = { active: '有效', expired: '已过期', revoked: '已吊销' };
const stateClasses = { active: 'net-positive', expired: 'net-zero', revoked: 'net-negative' };

function day(value) {
  return value ? value.slice(0, 10) : '—';
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function downloadP12(issued) {
  const bytes = Uint8Array.from(atob(issued.p12), (char) => char.charCodeAt(0));
  saveBlob(new Blob([bytes], { type: 'application/x-pkcs12' }), `${issued.certificate.name.replaceAll(' ', '_')}.p12`);
}

function megabytes(bytes) {
  if (bytes == null) return '—';
  return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

// What a rollback would undo, in words; the table above it has the row counts.
function restoreNotes(scope, preview) {
  const notes = [];
  const imports = preview.imports || [];
  const shown = imports.slice(0, 5).map((item) => `${item.fileName || '未命名'}（${beijingTime(item.importedAt)}）`).join('、');
  const what = scope === 'strategic' ? '战客清单导入' : '台账导入';
  notes.push(imports.length ? `撤销备份之后的 ${imports.length} 次${what}：${shown}${imports.length > 5 ? ' 等' : ''}。` : `备份之后没有新的${what}。`);
  if (scope === 'ledger') {
    if (preview.linesAdded) notes.push(`备份之后新出现的 ${preview.linesAdded} 条专线会消失。`);
    if (preview.linesChanged) notes.push(`${preview.linesChanged} 条专线恢复为备份时的内容。`);
    if (preview.linesRemoved) notes.push(`${preview.linesRemoved} 条备份里有、现在没有的专线会回来。`);
    if (preview.manualEdits) notes.push(`备份之后的 ${preview.manualEdits} 处手工修改会撤销。`);
    if (preview.forecastsChanged) notes.push(`${preview.forecastsChanged} 条 KPI 预计任务恢复为备份时的状态，包括落地确认和进展记录。`);
  }
  return notes;
}

function RestoreDialog({ backup, label, scopes, initialScope, onClose, onRestored }) {
  const [scope, setScope] = useState(initialScope || 'ledger');
  const [preview, setPreview] = useState({ data: null, loading: true, error: '' });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setPreview({ data: null, loading: true, error: '' });
    requestJson(`/settings/backups/${backup.name}/restore-preview`, { ...jsonBody('POST', { scope }), signal: controller.signal })
      .then((data) => setPreview({ data, loading: false, error: '' }))
      .catch((err) => {
        if (!isAbort(err)) setPreview({ data: null, loading: false, error: `比对失败：${err.message}` });
      });
    return () => controller.abort();
  }, [backup.name, scope]);

  const changedTables = (preview.data?.tables || []).filter((row) => row.current !== row.backup);
  const sameTables = (preview.data?.tables || []).filter((row) => row.current === row.backup);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onRestored(await requestJson(`/settings/backups/${backup.name}/restore`, jsonBody('POST', { scope, code })));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onClose(); }}>
      <form className="modal settings-dialog settings-restore" role="dialog" aria-modal="true" aria-label="回退数据" onSubmit={submit}>
        <h3>回退到 {beijingTime(backup.createdAt)} 的备份</h3>
        <p>{label}{backup.detail ? ` · ${backup.detail}` : ''}</p>
        <fieldset className="settings-scope" disabled={busy}>
          <legend>回退哪些数据</legend>
          {scopes.map((item) => (
            <label key={item.key} className="settings-scope-option">
              <input type="radio" name="restore-scope" value={item.key} checked={scope === item.key} onChange={() => setScope(item.key)} />
              <span><strong>{item.label}</strong><small>{item.tables.join('、')}</small></span>
            </label>
          ))}
        </fieldset>
        {preview.loading && <p className="subtle" role="status">正在比对当前数据和备份…</p>}
        <InlineError message={preview.error} />
        {preview.data && (
          <>
            {changedTables.length > 0 && (
              <div className="table-scroll settings-restore-scroll">
                <table className="settings-table">
                  <thead><tr><th>条数有变化的内容</th><th className="numeric">当前</th><th className="numeric">回退后</th></tr></thead>
                  <tbody>
                    {changedTables.map((row) => (
                      <tr key={row.table}>
                        <td>{row.label}</td>
                        <td className="numeric">{row.current.toLocaleString('zh-CN')}</td>
                        <td className="numeric settings-changed">{row.backup.toLocaleString('zh-CN')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {sameTables.length > 0 && <p className="subtle settings-restore-same">条数不变：{sameTables.map((row) => row.label).join('、')}</p>}
            <ul className="settings-restore-notes">
              {restoreNotes(scope, preview.data).map((note) => <li key={note}>{note}</li>)}
              <li>回退前会先自动备份当前数据，之后可以在列表里回退到那份“回退前”备份，撤销这次回退。账号、安全日志、收入数据、KPI 目标不受影响。</li>
            </ul>
          </>
        )}
        <label>
          Google Authenticator 验证码
          <input
            required
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="\d{6}"
            disabled={busy}
            onChange={(event) => setCode(event.target.value)}
          />
        </label>
        <InlineError message={error} />
        <div className="settings-actions">
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="settings-danger" disabled={busy || !preview.data}>{busy ? '正在回退…' : '确认回退'}</button>
        </div>
      </form>
    </div>
  );
}

function Backups({ reloadKey, onCode, onDataRestored }) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const [retry, setRetry] = useState(0);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [restoring, setRestoring] = useState(null);
  const [restored, setRestored] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));
    requestJson('/settings/backups', { signal: controller.signal })
      .then((data) => setState({ data, loading: false, error: '' }))
      .catch((err) => {
        if (!isAbort(err)) setState((current) => ({ ...current, loading: false, error: `备份列表读取失败：${err.message}` }));
      });
    return () => controller.abort();
  }, [reloadKey, retry]);

  async function createNow() {
    setCreating(true);
    setMessage('');
    try {
      const meta = await requestJson('/settings/backups', jsonBody('POST', {}));
      setMessage(`已备份（${beijingTime(meta.createdAt)}，${megabytes(meta.size)}）`);
      setRetry((value) => value + 1);
    } catch (err) {
      setState((current) => ({ ...current, error: `备份失败：${err.message}` }));
    } finally {
      setCreating(false);
    }
  }

  function download(item) {
    onCode({
      title: `下载备份：${beijingTime(item.createdAt)}`,
      detail: '备份是整个数据库，包含账号和 Google Authenticator 密钥。请存放在安全的位置，不要通过聊天工具转发。',
      confirm: '下载',
      run: async (code) => {
        let response;
        try {
          response = await fetch(`${apiBase}/settings/backups/${item.name}/download`, jsonBody('POST', { code }));
        } catch {
          throw new Error('无法连接服务，请确认服务正在运行');
        }
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(data?.error || `下载失败（${response.status}）`);
        }
        saveBlob(await response.blob(), item.name);
      }
    });
  }

  const data = state.data;
  const labels = Object.fromEntries((data?.reasons || []).map((item) => [item.key, item.label]));
  const scopeLabels = Object.fromEntries((data?.scopes || []).map((item) => [item.key, item.label]));

  function finishRestore(result) {
    setRestoring(null);
    setRestored(result);
    setMessage('');
    setRetry((value) => value + 1);
    onDataRestored();
  }

  return (
    <>
      {restored && (
        <div className="settings-restored" role="status">
          <span>
            已把{scopeLabels[restored.scope]}回退到 {beijingTime(restored.restored.createdAt)} 的备份。回退前的数据已另存为 {beijingTime(restored.before.createdAt)} 的“回退前”备份。
          </span>
          <button type="button" onClick={() => setRestoring({ backup: restored.before, scope: restored.scope })}>撤销这次回退</button>
        </div>
      )}
      <InlineError message={state.error} onRetry={() => setRetry((value) => value + 1)} />
      {data && (
        <dl className="settings-facts">
          <dt>保存位置</dt>
          <dd>{data.dir}</dd>
          <dt>剩余空间</dt>
          <dd>{megabytes(data.freeBytes)}（当前数据库 {megabytes(data.databaseSize)}）</dd>
          <dt>每周备份</dt>
          <dd>{data.lastWeeklyAt ? `上次 ${beijingTime(data.lastWeeklyAt)}，下次约 ${beijingTime(data.nextWeeklyAt)}` : '还没有，服务启动约 2 分钟后自动进行'}</dd>
          <dt>保留份数</dt>
          <dd>{data.reasons.map((item) => `${item.label} ${item.keep} 份`).join('；')}</dd>
        </dl>
      )}
      <div className="settings-actions">
        {message && <span className="subtle" role="status">{message}</span>}
        <button type="button" disabled={creating || !data} onClick={createNow}><DatabaseBackup size={16} /> {creating ? '正在备份…' : '立即备份'}</button>
      </div>
      <div className="table-scroll settings-backup-scroll">
        <table className="settings-table">
          <thead>
            <tr>
              <th>时间（北京时间）</th>
              <th>原因</th>
              <th>说明</th>
              <th className="numeric">台账专线</th>
              <th className="numeric">大小</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {(data?.backups || []).map((item) => (
              <tr key={item.name}>
                <td>{beijingTime(item.createdAt)}</td>
                <td>{labels[item.reason] || item.reason}</td>
                <td className="settings-wrap-cell">{item.detail || '—'}</td>
                <td className="numeric">{item.counts?.leasedLines ?? '—'}</td>
                <td className="numeric">{megabytes(item.size)}</td>
                <td>
                  <div className="settings-row-actions">
                    <button type="button" onClick={() => setRestoring({ backup: item })}><History size={14} /> 回退</button>
                    <button type="button" onClick={() => download(item)}><Download size={14} /> 下载</button>
                  </div>
                </td>
              </tr>
            ))}
            {!data?.backups.length && (
              <tr className="state-row">
                <td colSpan="6" className="empty">{state.loading ? '正在读取…' : state.error ? '读取失败，请重试' : '还没有备份'}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {restoring && data && (
        <RestoreDialog
          backup={restoring.backup}
          label={labels[restoring.backup.reason] || restoring.backup.reason}
          scopes={data.scopes}
          initialScope={restoring.scope}
          onClose={() => setRestoring(null)}
          onRestored={finishRestore}
        />
      )}
    </>
  );
}

function Section({ title, description, children }) {
  return (
    <section className="settings-section">
      <div className="settings-label">
        <h4>{title}</h4>
        {description}
      </div>
      <div className="settings-panel">{children}</div>
    </section>
  );
}

function SecurityLog({ reloadKey, certificates }) {
  const [category, setCategory] = useState('');
  const [log, setLog] = useState({ rows: [], hasMore: false, retentionDays: null, loading: true, error: '' });
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLog((current) => ({ ...current, loading: true, error: '' }));
    requestJson(`/settings/security-log?${new URLSearchParams({ category })}`, { signal: controller.signal })
      .then((value) => setLog({ ...value, loading: false, error: '' }))
      .catch((err) => {
        if (!isAbort(err)) setLog((current) => ({ ...current, loading: false, error: `安全日志读取失败：${err.message}` }));
      });
    return () => controller.abort();
  }, [category, reloadKey, retry]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const before = log.rows[log.rows.length - 1].id;
      const more = await requestJson(`/settings/security-log?${new URLSearchParams({ category, before })}`);
      setLog((current) => ({ ...current, rows: [...current.rows, ...more.rows], hasMore: more.hasMore, error: '' }));
    } catch (err) {
      setLog((current) => ({ ...current, error: `安全日志读取失败：${err.message}` }));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <div className="settings-log-head">
        <label className="select-field">
          事件类型
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            {securityLogCategories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        {log.loading && <span className="subtle" role="status">加载中</span>}
      </div>
      <InlineError message={log.error} onRetry={() => setRetry((value) => value + 1)} />
      <div className="table-scroll settings-log-scroll">
        <table className="settings-table">
          <thead>
            <tr>
              <th>时间（北京时间）</th>
              <th>事件</th>
              <th>账号</th>
              <th>来源</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {log.rows.map((row) => (
              <tr key={row.id}>
                <td>{beijingTime(row.at)}</td>
                <td className={isAlertEvent(row.event) ? 'net-negative' : undefined}>{securityEventLabels[row.event] || row.event}</td>
                <td>{row.username || '—'}</td>
                <td>{describeSource(row.source, certificates)}</td>
                <td>{row.detail || '—'}</td>
              </tr>
            ))}
            {log.rows.length === 0 && (
              <tr className="state-row">
                <td colSpan="5" className="empty">{log.loading ? '正在读取…' : log.error ? '读取失败，请重试' : '暂无符合条件的记录'}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {log.hasMore && (
        <div className="settings-actions">
          <button type="button" disabled={loadingMore} onClick={loadMore}>{loadingMore ? '加载中…' : '加载更多'}</button>
        </div>
      )}
    </>
  );
}

// Sensitive actions ask for the authenticator code again, on top of the login session.
function CodeDialog({ action, onClose }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await action.run(code);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onClose(); }}>
      <form className="modal settings-dialog" role="dialog" aria-modal="true" aria-label={action.title} onSubmit={submit}>
        <h3>{action.title}</h3>
        <p>{action.detail}</p>
        <label>
          Google Authenticator 验证码
          <input
            autoFocus
            required
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="\d{6}"
            onChange={(event) => setCode(event.target.value)}
          />
        </label>
        <InlineError message={error} />
        <div className="settings-actions">
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? '处理中…' : action.confirm}</button>
        </div>
      </form>
    </div>
  );
}

// Shown once: neither the file nor the password is kept on the server.
function IssuedDialog({ issued, onClose }) {
  const [downloaded, setDownloaded] = useState(false);
  const [copyState, setCopyState] = useState('');

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(issued.password);
      setCopyState('已复制');
    } catch {
      setCopyState('无法自动复制，请手动选中密码');
    }
  }

  return (
    <div className="modal-mask">
      <div className="modal settings-dialog" role="dialog" aria-modal="true" aria-label="证书已签发">
        <h3>证书已签发：{issued.certificate.name}</h3>
        <p>文件和密码都<strong>只在这里出现一次</strong>，服务器不保存。关闭后如果丢失，只能吊销并重新签发。</p>
        <dl className="settings-issued">
          <dt>有效至</dt>
          <dd>{day(issued.certificate.expiresAt)}</dd>
          <dt>导入密码</dt>
          <dd><code>{issued.password}</code></dd>
        </dl>
        <div className="settings-issued-actions">
          <button type="button" onClick={() => { downloadP12(issued); setDownloaded(true); }}>
            <Download size={16} /> 下载证书文件
          </button>
          <button type="button" onClick={copyPassword}><Copy size={16} /> 复制密码</button>
          {copyState && <span className="subtle" role="status">{copyState}</span>}
        </div>
        <p className="subtle">把文件和密码分两条渠道发给使用人，不要放在同一条消息里。手机导入后请删除文件。</p>
        <div className="settings-actions">
          <button type="button" className="primary" disabled={!downloaded} onClick={onClose}>
            {downloaded ? '已保存，关闭' : '请先下载证书文件'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Settings({ refreshToken, onDataRestored = () => {} }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState(null);
  const [device, setDevice] = useState({ name: '', days: '' });
  const [codeAction, setCodeAction] = useState(null);
  const [issued, setIssued] = useState(null);
  const [saved, setSaved] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(null);
  const [revoking, setRevoking] = useState(false);
  const [category, setCategory] = useState(savedCategory);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    requestJson(certPath, { signal: controller.signal })
      .then((value) => {
        setData(value);
        setDraft({ enabled: value.settings.enabled, port: String(value.settings.port), defaultDays: String(value.settings.defaultDays) });
        setLoading(false);
      })
      .catch((err) => {
        if (isAbort(err)) return;
        setError(`设置读取失败：${err.message}`);
        setLoading(false);
      });
    return () => controller.abort();
  }, [refreshToken, revision]);

  const reload = () => setRevision((value) => value + 1);
  const readOnly = Boolean(data?.readOnly);
  const hasCa = Boolean(data?.ca.exists);
  const certificates = data?.certificates || [];
  const activeCount = certificates.filter((item) => item.state === 'active').length;

  function createCa() {
    setCodeAction({
      title: '创建证书机构',
      detail: `将在服务器上创建用于签发设备证书的证书机构，保存在 ${data.ca.dir}。只需要做一次。`,
      confirm: '创建',
      run: async (code) => {
        await requestJson(`${certPath}/ca`, jsonBody('POST', { code }));
        reload();
      }
    });
  }

  function savePort(event) {
    event.preventDefault();
    setSaved('');
    setCodeAction({
      title: draft.enabled ? `开启设备证书端口 ${draft.port}` : '保存端口设置',
      detail: draft.enabled ? '保存后端口立即开启，无需重启服务。' : '保存后端口立即关闭，已导入证书的手机将无法连接。',
      confirm: '保存',
      run: async (code) => {
        await requestJson(`${certPath}/settings`, jsonBody('PUT', {
          code,
          enabled: draft.enabled,
          port: Number(draft.port),
          defaultDays: Number(draft.defaultDays)
        }));
        setSaved('已保存');
        reload();
      }
    });
  }

  function issueCert(event) {
    event.preventDefault();
    setCodeAction({
      title: `为“${device.name.trim()}”签发证书`,
      detail: '持有这张证书的手机可以打开设备证书端口的登录页，仍需账号、密码和验证码才能登录。',
      confirm: '签发',
      run: async (code) => {
        const result = await requestJson(`${certPath}/certificates`, jsonBody('POST', { code, name: device.name, days: device.days }));
        setIssued(result);
        setDevice({ name: '', days: '' });
        reload();
      }
    });
  }

  async function revoke(item) {
    setRevoking(true);
    setError('');
    try {
      await requestJson(`${certPath}/certificates/${item.serial}/revoke`, jsonBody('POST', {}));
      setConfirmRevoke(null);
      reload();
    } catch (err) {
      setError(`吊销失败：${err.message}`);
    } finally {
      setRevoking(false);
    }
  }

  function portStatus() {
    const { listener, settings } = data;
    if (!listener.available) return { text: '当前服务未启用 HTTPS，无法开启', className: 'net-zero' };
    if (listener.running) return { text: `运行中，端口 ${listener.port}`, className: 'net-positive' };
    if (settings.enabled) return { text: `已设为开启但没有运行，请查看服务日志（端口 ${settings.port}）`, className: 'net-negative' };
    return { text: '未开启', className: 'net-zero' };
  }

  const status = data ? portStatus() : null;
  const current = settingsCategories.find((item) => item.key === category);

  function chooseCategory(key) {
    setCategory(key);
    try {
      localStorage.setItem(categoryStorageKey, key);
    } catch {
      // Remembering the last category is a convenience; without storage it starts at the first.
    }
  }

  return (
    <main className="page settings-page">
      <div className="page-heading">
        <h2>设置</h2>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {settingsCategories.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.key} type="button" aria-current={category === item.key ? 'page' : undefined} onClick={() => chooseCategory(item.key)}>
                <Icon size={16} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="settings-content">
          <div className="settings-content-heading">
            <h3>{current.label}</h3>
            <p>{current.description}</p>
          </div>

          <InlineError message={error} onRetry={reload} />
          {readOnly && category === 'access' && <InlineError message="当前通过设备证书端口访问，只能查看。管理证书请从公司网络打开系统。" />}
          {loading && !data && <p className="subtle" role="status">正在读取设置…</p>}

          {data && draft && category === 'access' && (
            <>
              <Section
                title="证书机构"
                description={<p>签发和识别设备证书的根。只创建一次，请单独备份所在目录。</p>}
              >
                {hasCa ? (
                  <dl className="settings-facts">
                    <dt>状态</dt>
                    <dd className="net-positive">已创建</dd>
                    <dt>有效至</dt>
                    <dd>{day(data.ca.expiresAt)}</dd>
                    <dt>保存位置</dt>
                    <dd>{data.ca.dir}</dd>
                  </dl>
                ) : (
                  <>
                    <p className="subtle">还没有创建。创建后才能开启端口和签发证书。目录不能放在 OneDrive 等云同步文件夹内。</p>
                    <div className="settings-actions">
                      <button type="button" disabled={readOnly} onClick={createCa}><ShieldCheck size={16} /> 创建证书机构</button>
                    </div>
                  </>
                )}
              </Section>

              <Section
                title="访问端口"
                description={<p>这个端口对外开放，但没有证书连登录页都看不到。防火墙和云平台安全组需要另外放行，这里改不了。</p>}
              >
                <form onSubmit={savePort}>
                  <p className="settings-status">当前状态：<span className={status.className}>{status.text}</span></p>
                  <label className={`kpi-mode-toggle settings-toggle${draft.enabled ? ' active' : ''}`}>
                    <span>开启设备证书端口</span>
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      disabled={readOnly || !hasCa}
                      onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                    />
                    <span className="kpi-toggle-track" aria-hidden="true"><span className="kpi-toggle-thumb" /></span>
                  </label>
                  <div className="settings-fields">
                    <label>
                      端口
                      <input type="number" min="1024" max="65535" required disabled={readOnly || !hasCa} value={draft.port} onChange={(event) => setDraft({ ...draft, port: event.target.value })} />
                    </label>
                    <label>
                      证书默认有效天数
                      <input type="number" min="1" max="3650" required disabled={readOnly || !hasCa} value={draft.defaultDays} onChange={(event) => setDraft({ ...draft, defaultDays: event.target.value })} />
                    </label>
                  </div>
                  <p className="subtle">手机上填写的地址：<code>https://{window.location.hostname}:{draft.port || '端口'}</code></p>
                  <div className="settings-actions">
                    {saved && <span className="subtle" role="status">{saved}</span>}
                    <button type="submit" disabled={readOnly || !hasCa}>保存</button>
                  </div>
                  {!hasCa && <p className="subtle">请先创建证书机构。</p>}
                </form>
              </Section>

              <Section
                title="下发证书"
                description={(
                  <ol>
                    <li>填写设备名并签发，下载 .p12 文件。</li>
                    <li>把文件和密码分两条渠道发给使用人。</li>
                    <li>对方在 App 的服务器地址页点“导入证书”，填上面的地址连接。</li>
                  </ol>
                )}
              >
                <form onSubmit={issueCert}>
                  <div className="settings-fields">
                    <label>
                      设备名
                      <input required maxLength={40} disabled={readOnly || !hasCa} placeholder="例如 张三手机" value={device.name} onChange={(event) => setDevice({ ...device, name: event.target.value })} />
                    </label>
                    <label>
                      有效天数
                      <input type="number" min="1" max="3650" disabled={readOnly || !hasCa} placeholder={`默认 ${data.settings.defaultDays}`} value={device.days} onChange={(event) => setDevice({ ...device, days: event.target.value })} />
                    </label>
                  </div>
                  <div className="settings-actions">
                    <button type="submit" disabled={readOnly || !hasCa}><FilePlus2 size={16} /> 签发证书</button>
                  </div>
                  {!hasCa && <p className="subtle">请先创建证书机构。</p>}
                </form>
              </Section>

              <Section
                title="已下发的证书"
                description={<p>有效 {activeCount} 张，共 {certificates.length} 张。手机丢失或人员离职时吊销，下一个请求起生效，无需重启。</p>}
              >
                <div className="table-scroll">
                  <table className="settings-table">
                    <thead>
                      <tr>
                        <th>设备</th>
                        <th>状态</th>
                        <th>签发日期</th>
                        <th>有效至</th>
                        <th>签发人</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {certificates.map((item) => (
                        <tr key={item.serial} className={item.state === 'active' ? undefined : 'settings-inactive'}>
                          <td title={`序列号 ${item.serial}`}>{item.name}</td>
                          <td className={stateClasses[item.state]}>{stateLabels[item.state]}</td>
                          <td>{day(item.issuedAt)}</td>
                          <td>{day(item.expiresAt)}</td>
                          <td>{item.issuedBy || '—'}</td>
                          <td>
                            {item.state === 'revoked' ? '—' : confirmRevoke === item.serial ? (
                              <div className="settings-row-actions">
                                <button type="button" className="settings-danger" disabled={revoking} onClick={() => revoke(item)}>确认吊销 {item.name}</button>
                                <button type="button" disabled={revoking} onClick={() => setConfirmRevoke(null)}>取消</button>
                              </div>
                            ) : (
                              <div className="settings-row-actions">
                                <button type="button" className="settings-danger" disabled={readOnly} onClick={() => setConfirmRevoke(item.serial)}><ShieldOff size={14} /> 吊销</button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                      {certificates.length === 0 && (
                        <tr className="state-row">
                          <td colSpan="6" className="empty">还没有下发过证书</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Section>
            </>
          )}

          {data && category === 'backup' && (
            <Section
              title="数据备份"
              description={(
                <>
                  <p>每次导入到达日清单、替换战客清单之前，以及每周一次自动备份。在列表中点“回退”，先看会撤销什么，再确认。</p>
                  <p>备份和数据库在同一台服务器上，防得了误操作，防不了服务器故障。请定期下载一份存到别处。</p>
                </>
              )}
            >
              {readOnly
                ? <p className="subtle settings-first">通过设备证书端口登录时不能管理备份，请从公司网络访问。</p>
                : <Backups reloadKey={`${refreshToken}:${revision}`} onCode={setCodeAction} onDataRestored={onDataRestored} />}
            </Section>
          )}

          {data && category === 'log' && (
            <Section
              title="操作记录"
              description={<p>保留 180 天。不记录密码和验证码；握手阶段就被拒绝的连接和命令行操作不在其中。</p>}
            >
              {readOnly
                ? <p className="subtle settings-first">通过设备证书端口登录时不能查看，请从公司网络访问。</p>
                : <SecurityLog reloadKey={`${refreshToken}:${revision}`} certificates={certificates} />}
            </Section>
          )}
        </div>
      </div>

      {codeAction && <CodeDialog action={codeAction} onClose={() => setCodeAction(null)} />}
      {issued && <IssuedDialog issued={issued} onClose={() => setIssued(null)} />}
    </main>
  );
}
