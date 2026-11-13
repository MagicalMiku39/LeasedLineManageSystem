import http from 'node:http';
import https from 'node:https';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { Router } from 'express';
import { createConnectionGuard, defaultConnectionLimits, requestSource } from './client-cert.js';

const defaults = { enabled: false, port: 9443, publicUrl: '' };
// scheme://host[:port] and nothing after it: the link's own path is added by the system.
const publicUrlPattern = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

/** A problem the person can act on; its message is shown as is. */
export class FillPortError extends Error {}

/**
 * 填报端口: a second port that can be opened to the internet so a manager can use a fill link
 * from anywhere. It serves the fill page and the fill API and nothing else: no login page, no
 * ledger, no settings. The token in a link is still the only key to any data. Off by default.
 */
export function createFillPort({ db, distDir, limits = defaultConnectionLimits }) {
  db.exec(`CREATE TABLE IF NOT EXISTS fill_port_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL,
    port INTEGER NOT NULL,
    public_url TEXT NOT NULL,
    updated_by TEXT,
    updated_at TEXT NOT NULL
  )`);

  function readSettings() {
    const row = db.prepare('SELECT enabled, port, public_url FROM fill_port_settings WHERE id = 1').get();
    return row ? { enabled: Boolean(row.enabled), port: row.port, publicUrl: row.public_url } : { ...defaults };
  }

  function writeSettings(settings, username) {
    db.prepare(`INSERT INTO fill_port_settings (id, enabled, port, public_url, updated_by, updated_at) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, port = excluded.port, public_url = excluded.public_url,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(settings.enabled ? 1 : 0, settings.port, settings.publicUrl, username, new Date().toISOString());
  }

  // Everything this port answers. Whatever is not listed here does not exist on it.
  function buildApp(fillRouter) {
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      // The token is in the address: keep it out of other sites' logs, caches and search engines.
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      next();
    });
    app.use('/api/fill', express.json({ limit: '64kb' }), fillRouter);
    if (existsSync(distDir)) {
      app.use('/assets', express.static(join(distDir, 'assets'), { index: false, fallthrough: true, maxAge: '1h' }));
      app.get(/^\/fill\/[A-Za-z0-9_-]+\/?$/, (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(join(distDir, 'index.html'));
      });
    }
    app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));
    // An error says nothing about the system behind it.
    app.use((error, req, res, _next) => {
      console.error(`Fill port ${req.method} ${req.path.replace(/\/fill\/[^/]+/, '/fill/…')} failed:`, error.message);
      if (!res.headersSent) res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: '请求无法处理' });
    });
    return app;
  }

  let app = null;
  let tls = null;
  let host = '0.0.0.0';
  let reservedPorts = [];
  let server = null;
  let runningPort = null;

  async function stop() {
    if (!server) return;
    const closing = server;
    server = null;
    runningPort = null;
    closing.closeAllConnections();
    await new Promise((resolve) => closing.close(resolve));
  }

  async function start(port) {
    if (!app) throw new FillPortError('填报端口还没有准备好');
    if (server && runningPort === port) return;
    // The same certificate as the main port; with no HTTPS at all (local use) it is plain HTTP too.
    const next = tls ? https.createServer({ ...tls, handshakeTimeout: limits.handshakeTimeout }, app) : http.createServer(app);
    next.maxConnections = limits.maxConnections;
    next.requestTimeout = 30000;
    next.headersTimeout = 15000;
    const guard = createConnectionGuard(limits);
    next.on('connection', (socket) => {
      const ip = socket.remoteAddress;
      if (!guard.admit(ip)) {
        socket.destroy();
        return;
      }
      socket.once('close', () => guard.release(ip));
    });
    await new Promise((resolve, reject) => {
      next.once('error', (error) => {
        reject(new FillPortError(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请换一个` : `端口 ${port} 无法开启：${error.message}`));
      });
      next.listen(port, host, resolve);
    });
    next.on('error', (error) => console.error(`Fill port failed: ${error.message}`));
    await stop();
    server = next;
    runningPort = port;
  }

  const status = () => ({ secure: Boolean(tls), running: Boolean(server), port: runningPort, reservedPorts });

  /** Settings page API: only from the main port, and a change asks for the authenticator code. */
  function createRouter({ currentUser, verifyCode, logEvent = () => {}, otherPorts = () => [] }) {
    const router = Router();
    router.get('/', (req, res) => {
      res.json({ readOnly: requestSource(req).startsWith('cert:'), settings: readSettings(), listener: status() });
    });
    router.put('/', async (req, res) => {
      if (requestSource(req).startsWith('cert:')) return res.status(403).json({ error: '通过设备证书端口登录时不能修改填报端口，请从公司网络访问' });
      try {
        if (!verifyCode(currentUser(req)?.username, req.body?.code, requestSource(req))) {
          return res.status(403).json({ error: '验证码不正确，请输入 Google Authenticator 当前显示的 6 位数字' });
        }
      } catch (error) {
        if (!error.status) throw error;
        return res.status(error.status).json({ error: error.message });
      }
      const body = req.body || {};
      const port = Number(body.port);
      const publicUrl = String(body.publicUrl ?? '').trim().replace(/\/+$/, '');
      if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: '开关状态不正确' });
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return res.status(400).json({ error: '端口须为 1024–65535 的整数' });
      if ([...reservedPorts, ...otherPorts()].includes(port)) return res.status(400).json({ error: `端口 ${port} 已用于系统的其他服务，请换一个` });
      if (publicUrl && !publicUrlPattern.test(publicUrl)) return res.status(400).json({ error: '对外填报地址的格式应为 https://域名或IP:端口，后面不带路径' });
      if (body.enabled && !publicUrl) return res.status(400).json({ error: '开启时请填写对外填报地址，邮件里的链接会用它' });
      try {
        // The port changes first, so a failed start leaves the saved settings as they were.
        if (body.enabled) await start(port);
        else await stop();
        writeSettings({ enabled: body.enabled, port, publicUrl }, currentUser(req)?.username || '');
        logEvent('fill_port_changed', { username: currentUser(req)?.username || '', source: requestSource(req), detail: `${body.enabled ? '开启' : '关闭'}，端口 ${port}${publicUrl ? `，对外地址 ${publicUrl}` : ''}` });
        res.json({ settings: readSettings(), listener: status() });
      } catch (error) {
        if (error instanceof FillPortError) res.status(400).json({ error: error.message });
        else res.status(500).json({ error: `填报端口操作失败：${error.message}` });
      }
    });
    return router;
  }

  return {
    /** The fill API this port serves; set once the share service exists. */
    attach(fillRouter) { app = buildApp(fillRouter); },
    configure(options) { ({ tls = null, host = '0.0.0.0', reservedPorts = [] } = options); },
    readSettings,
    status,
    start,
    stop,
    createRouter,
    /** The address a link should start with: the public one while the port is on, else the caller's. */
    linkBase(fallback) {
      const settings = readSettings();
      return settings.enabled && settings.publicUrl ? settings.publicUrl : fallback;
    },
    /** For tests and for the fill page on the main port: the same headers a link's page needs. */
    app: () => app
  };
}
