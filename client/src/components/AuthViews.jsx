import React, { useState } from 'react';
import { KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { jsonBody, requestJson } from '../api.js';

export function SetupView({ onReady }) {
  const [form, setForm] = useState({ username: 'admin', password: '' });
  const [setupInfo, setSetupInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      setSetupInfo(await requestJson('/auth/setup', jsonBody('POST', form)));
    } catch (failure) {
      setError(failure.message || '初始化失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-panel" onSubmit={submit}>
        <div className="auth-mark"><ShieldCheck size={28} /></div>
        <h1>初始化管理员</h1>
        <p>首次使用需要创建账号，并将密钥添加到 Google Authenticator。</p>
        <label>账号<input autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label>密码<input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="至少 8 位" /></label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        {!setupInfo && <button className="primary auth-submit" type="submit" disabled={busy}>{busy ? '正在生成' : '生成验证器密钥'}</button>}
        {setupInfo && (
          <div className="setup-secret">
            <span>Google Authenticator 设置密钥</span>
            <strong>{setupInfo.totpSecret}</strong>
            <small>在 Google Authenticator 中选择手动输入密钥，账号名填写 {setupInfo.username}。</small>
            <button className="primary auth-submit" type="button" onClick={onReady}>已添加，去登录</button>
          </div>
        )}
      </form>
    </div>
  );
}

export function LoginView({ onLogin }) {
  const [form, setForm] = useState({ username: 'admin', password: '', code: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await requestJson('/auth/login', jsonBody('POST', form));
      onLogin(data.user);
    } catch (failure) {
      setError(failure.message || '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-panel" onSubmit={submit}>
        <div className="auth-mark"><KeyRound size={28} /></div>
        <h1>登录系统</h1>
        <p>登录成功后 7 天内可自动登录。验证码来自 Google Authenticator。</p>
        <label>账号<input autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label>密码<input type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <label>验证码<input autoComplete="one-time-code" value={form.code} inputMode="numeric" maxLength="6" onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="6 位动态验证码" /></label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="primary auth-submit" type="submit" disabled={loading}>{loading ? '登录中' : '登录'}</button>
      </form>
    </div>
  );
}

// Shown while the session is checked, and with a retry when the service cannot be reached.
export function AuthStatusView({ error, onRetry }) {
  return (
    <div className="auth-page">
      <div className="auth-panel" role={error ? 'alert' : 'status'}>
        <h1>{error ? '无法连接系统' : '正在加载'}</h1>
        {error && (
          <>
            <p>{error}</p>
            <button className="primary auth-submit" type="button" onClick={onRetry}><RefreshCw size={16} /> 重试</button>
          </>
        )}
      </div>
    </div>
  );
}
