import React, { useEffect, useState } from 'react';
import { Copy, Download, FilePlus2, ShieldCheck, ShieldOff } from 'lucide-react';
import { isAbort, jsonBody, requestJson } from './api.js';
import { InlineError } from './components/Feedback.jsx';
import { describeSource, isAlertEvent, securityEventLabels, securityLogCategories } from './securityLog.js';
import { beijingTime } from './utils.js';
import './settings.css';

const certPath = '/settings/client-certs';
const stateLabels = { active: '有效', expired: '已过期', revoked: '已吊销' };
const stateClasses = { active: 'net-positive', expired: 'net-zero', revoked: 'net-negative' };

function day(value) {
  return value ? value.slice(0, 10) : '—';
}

function downloadP12(issued) {
  const bytes = Uint8Array.from(atob(issued.p12), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/x-pkcs12' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${issued.certificate.name.replaceAll(' ', '_')}.p12`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function Section({ title, description, children }) {
  return (
    <section className="settings-section">
      <div className="settings-label">
        <h3>{title}</h3>
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

export default function Settings({ refreshToken }) {
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

  return (
    <main className="page settings-page">
      <div className="page-heading">
        <h2>设置</h2>
        <p>设备证书：让 IP 不固定的手机安全访问系统，不用逐个开放 IP 白名单。</p>
      </div>

      <InlineError message={error} onRetry={reload} />
      {readOnly && <InlineError message="当前通过设备证书端口访问，只能查看。管理证书请从公司网络打开系统。" />}
      {loading && !data && <p className="subtle" role="status">正在读取设置…</p>}

      {data && draft && (
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

          <Section
            title="安全日志"
            description={<p>登录、设置页验证码、证书和端口操作的记录，保留 180 天。不记录密码和验证码；握手阶段就被拒绝的连接和命令行操作不在其中。</p>}
          >
            {readOnly
              ? <p className="subtle settings-first">通过设备证书端口登录时不能查看，请从公司网络访问。</p>
              : <SecurityLog reloadKey={`${refreshToken}:${revision}`} certificates={certificates} />}
          </Section>
        </>
      )}

      {codeAction && <CodeDialog action={codeAction} onClose={() => setCodeAction(null)} />}
      {issued && <IssuedDialog issued={issued} onClose={() => setIssued(null)} />}
    </main>
  );
}
