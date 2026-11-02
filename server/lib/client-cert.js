import https from 'node:https';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A problem the person can act on; its message is shown as is. */
export class ClientCertError extends Error {}

// Where the private CA and the record of issued device certificates live. Never committed.
export function clientCertPaths(dir = process.env.CLIENT_CERT_DIR || join(process.cwd(), 'certs', 'client')) {
  return {
    dir,
    caKey: join(dir, 'ca.key'),
    caCert: join(dir, 'ca.crt'),
    registry: join(dir, 'issued.json'),
    settings: join(dir, 'settings.json'),
    issuedDir: join(dir, 'issued')
  };
}

export function normalizeSerial(value) {
  return String(value || '').replace(/[^0-9a-f]/gi, '').replace(/^0+/, '').toUpperCase();
}

/**
 * Answers whether a certificate serial is issued and not revoked. Revoking takes effect without
 * a restart because the file is re-read when it changes. A missing or unreadable record denies
 * everything: this port must fail closed.
 */
export function createSerialCheck(registryFile) {
  let loaded = null;
  return (serial) => {
    try {
      const { mtimeMs, size } = statSync(registryFile);
      if (!loaded || loaded.mtimeMs !== mtimeMs || loaded.size !== size) {
        const { certificates } = JSON.parse(readFileSync(registryFile, 'utf8'));
        const active = certificates.filter((item) => !item.revokedAt).map((item) => normalizeSerial(item.serial));
        loaded = { mtimeMs, size, active: new Set(active) };
      }
    } catch {
      loaded = null;
      return false;
    }
    const normalized = normalizeSerial(serial);
    return Boolean(normalized) && loaded.active.has(normalized);
  };
}

/** Who is asking: the device certificate when there is one, otherwise the IP address. */
export function requestSource(req) {
  const serial = typeof req.socket.getPeerCertificate === 'function' ? req.socket.getPeerCertificate()?.serialNumber : '';
  return serial ? `cert:${normalizeSerial(serial)}` : `ip:${req.socket.remoteAddress}`;
}

// This port is open to everyone and shares a process with the main port, so the cost a stranger
// can impose before presenting a certificate has to stay small. A burst of page requests opens
// about 6 connections and idle ones close after 5 seconds, so normal use, even a few phones
// behind one mobile NAT address, stays well below these limits.
export const defaultConnectionLimits = {
  maxConnections: 256,
  maxPerIp: 20,
  perIpPerMinute: 120,
  handshakeTimeout: 10000
};

/** Decides per IP whether a new connection may start its TLS handshake. */
export function createConnectionGuard({ maxPerIp, perIpPerMinute }, now = Date.now) {
  const seen = new Map();
  let lastSweep = now();

  function sweep(time) {
    if (time - lastSweep < 60000) return;
    lastSweep = time;
    for (const [ip, entry] of seen) {
      entry.starts = entry.starts.filter((start) => time - start < 60000);
      if (entry.open === 0 && entry.starts.length === 0) seen.delete(ip);
    }
  }

  return {
    admit(ip) {
      const time = now();
      sweep(time);
      const entry = seen.get(ip) || { open: 0, starts: [] };
      seen.set(ip, entry);
      entry.starts = entry.starts.filter((start) => time - start < 60000);
      if (entry.open >= maxPerIp || entry.starts.length >= perIpPerMinute) return false;
      entry.open += 1;
      entry.starts.push(time);
      return true;
    },
    release(ip) {
      const entry = seen.get(ip);
      if (entry) entry.open -= 1;
    }
  };
}

/**
 * An HTTPS server that serves `app` only to devices holding a certificate from our CA: without
 * one the TLS handshake fails, and a revoked one is cut off at its next request, including on a
 * connection that is already open. Login with password and authenticator code still applies.
 * TLS 1.3 only: it also keeps the device name in the certificate off the wire.
 */
export function createClientCertServer({ app, tls, paths, limits = defaultConnectionLimits }) {
  const isActive = createSerialCheck(paths.registry);
  const options = {
    ...tls,
    ca: readFileSync(paths.caCert),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
    handshakeTimeout: limits.handshakeTimeout
  };
  const server = https.createServer(options, (req, res) => {
    if (!isActive(req.socket.getPeerCertificate()?.serialNumber)) {
      req.socket.destroy();
      return;
    }
    app(req, res);
  });
  server.maxConnections = limits.maxConnections;
  const guard = createConnectionGuard(limits);
  server.on('connection', (socket) => {
    const ip = socket.remoteAddress;
    if (!guard.admit(ip)) {
      socket.destroy();
      return;
    }
    socket.once('close', () => guard.release(ip));
  });
  return server;
}

/** Opens and closes the device certificate port while the service runs. */
export function createClientCertListener({ app, paths }) {
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

  return {
    configure(options) {
      ({ tls, host = '0.0.0.0', reservedPorts = [] } = options);
    },
    status() {
      return { available: Boolean(tls), running: Boolean(server), port: runningPort, reservedPorts };
    },
    async start(port) {
      if (!tls) throw new ClientCertError('当前服务没有启用 HTTPS，无法开启设备证书端口');
      if (server && runningPort === port) return;
      const next = createClientCertServer({ app, tls, paths });
      await new Promise((resolve, reject) => {
        next.once('error', (error) => {
          reject(new ClientCertError(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请换一个` : `端口 ${port} 无法开启：${error.message}`));
        });
        next.listen(port, host, resolve);
      });
      next.on('error', (error) => console.error(`Client certificate port failed: ${error.message}`));
      await stop();
      server = next;
      runningPort = port;
    },
    stop
  };
}
