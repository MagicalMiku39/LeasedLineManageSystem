import { Router } from 'express';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import {
  caExists,
  ClientCertError,
  initCa,
  issueCertificate,
  listCertificates,
  readClientCertSettings,
  revokeCertificate,
  writeClientCertSettings
} from './client-cert-admin.js';
import { requestSource } from './client-cert.js';

// Requests that arrived with a device certificate, i.e. through the device certificate port.
function viaDeviceCertificate(req) {
  return requestSource(req).startsWith('cert:');
}

function caExpiry(paths) {
  try {
    return new crypto.X509Certificate(readFileSync(paths.caCert)).validTo;
  } catch {
    return null;
  }
}

/**
 * Settings page API. Only the main port can change anything, so a device that lost its
 * certificate's protection can never mint another one. Creating the CA, changing the port and
 * issuing also ask for the current authenticator code, on top of the login session.
 */
export function createClientCertRouter({ paths, listener, currentUser, verifyCode, logEvent = () => {} }) {
  const router = Router();

  function record(req, event, detail) {
    logEvent(event, { username: currentUser(req)?.username || '', source: requestSource(req), detail });
  }

  function guard(req, res, needsCode = true) {
    if (viaDeviceCertificate(req)) {
      res.status(403).json({ error: '通过设备证书端口登录时不能管理证书，请从公司网络访问' });
      return false;
    }
    if (!needsCode) return true;
    try {
      if (verifyCode(currentUser(req)?.username, req.body?.code, requestSource(req))) return true;
      res.status(403).json({ error: '验证码不正确，请输入 Google Authenticator 当前显示的 6 位数字' });
    } catch (error) {
      if (!error.status) throw error;
      res.status(error.status).json({ error: error.message });
    }
    return false;
  }

  function fail(res, error) {
    if (error instanceof ClientCertError) res.status(400).json({ error: error.message });
    else res.status(500).json({ error: `设备证书操作失败：${error.message}` });
  }

  router.get('/', (req, res) => {
    const hasCa = caExists(paths);
    const expiry = hasCa ? caExpiry(paths) : null;
    res.json({
      readOnly: viaDeviceCertificate(req),
      ca: { exists: hasCa, dir: paths.dir, expiresAt: expiry ? new Date(expiry).toISOString() : null },
      settings: readClientCertSettings(paths),
      listener: listener.status(),
      certificates: hasCa ? listCertificates(paths) : []
    });
  });

  router.post('/ca', (req, res) => {
    if (!guard(req, res)) return;
    try {
      initCa(paths);
      record(req, 'ca_created', paths.dir);
      res.status(201).json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.put('/settings', async (req, res) => {
    if (!guard(req, res)) return;
    const body = req.body || {};
    const port = Number(body.port);
    const defaultDays = Number(body.defaultDays);
    if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: '开关状态不正确' });
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return res.status(400).json({ error: '端口须为 1024–65535 的整数' });
    if (listener.status().reservedPorts.includes(port)) return res.status(400).json({ error: `端口 ${port} 已用于系统主服务，请换一个` });
    if (!Number.isInteger(defaultDays) || defaultDays <= 0 || defaultDays > 3650) return res.status(400).json({ error: '默认有效天数须为 1–3650 的整数' });
    if (body.enabled && !caExists(paths)) return res.status(400).json({ error: '请先创建证书机构' });
    if (body.enabled && !listener.status().available) return res.status(400).json({ error: '当前服务没有启用 HTTPS，无法开启设备证书端口' });
    try {
      // The port changes first, so a failed start leaves the saved settings as they were.
      if (body.enabled) await listener.start(port);
      else await listener.stop();
      writeClientCertSettings(paths, { enabled: body.enabled, port, defaultDays });
      record(req, 'port_changed', `${body.enabled ? '开启' : '关闭'}，端口 ${port}，证书默认有效 ${defaultDays} 天`);
      res.json({ settings: readClientCertSettings(paths), listener: listener.status() });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/certificates', (req, res) => {
    if (!guard(req, res)) return;
    const days = req.body?.days === undefined || req.body?.days === ''
      ? readClientCertSettings(paths).defaultDays
      : Number(req.body.days);
    try {
      const { certificate, p12, password } = issueCertificate(paths, { name: req.body?.name, days, issuedBy: currentUser(req)?.username || '' });
      record(req, 'cert_issued', `${certificate.name}，有效 ${days} 天，序列号 ${certificate.serial}`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({ certificate, password, p12: p12.toString('base64') });
    } catch (error) {
      fail(res, error);
    }
  });

  // Revoking only ever takes access away, so it stays quick: no code needed in an emergency.
  router.post('/certificates/:serial/revoke', (req, res) => {
    if (!guard(req, res, false)) return;
    try {
      const revoked = revokeCertificate(paths, req.params.serial, currentUser(req)?.username || '');
      record(req, 'cert_revoked', `${revoked.name}，序列号 ${revoked.serial}`);
      res.json(revoked);
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
