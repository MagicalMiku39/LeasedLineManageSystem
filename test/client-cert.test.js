import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { caExists, initCa, readClientCertSettings } from '../server/lib/client-cert-admin.js';
import { clientCertPaths, createClientCertListener, createClientCertServer, createConnectionGuard, createSerialCheck, normalizeSerial } from '../server/lib/client-cert.js';
import { createClientCertRouter } from '../server/lib/client-cert-router.js';

const script = join(process.cwd(), 'server', 'scripts', 'client-cert.js');
const openssl = [process.env.OPENSSL_BIN, 'openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']
  .filter(Boolean)
  .find((bin) => spawnSync(bin, ['version'], { stdio: 'ignore' }).status === 0);
const hasOpenssl = Boolean(openssl);
const root = mkdtempSync(join(tmpdir(), 'client-cert-tests-'));

after(() => rmSync(root, { recursive: true, force: true }));

function run(dir, ...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, CLIENT_CERT_DIR: dir } });
}

function issueDevice(dir, name) {
  const result = run(dir, 'issue', name);
  assert.equal(result.status, 0, result.stderr);
  const field = (label) => new RegExp(`${label}：(.+)`).exec(result.stdout)[1].trim();
  return { pfx: readFileSync(field('证书文件')), passphrase: field('导入密码'), serial: field('序列号') };
}

function get(port, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get({ host: '127.0.0.1', port, rejectUnauthorized: false, ...options }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
  });
}

function postViaDevice(port, device, path) {
  return new Promise((resolve, reject) => {
    const request = https.request({ host: '127.0.0.1', port, method: 'POST', rejectUnauthorized: false, ...device, path, headers: { 'Content-Type': 'application/json' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end('{"code":"123456"}');
  });
}

test('settings API creates the CA, opens the port, issues and revokes', { skip: !hasOpenssl }, async () => {
  const dir = mkdtempSync(join(root, 'settings-'));
  const paths = clientCertPaths(dir);
  const app = express();
  app.use(express.json());
  const listener = createClientCertListener({ app, paths });
  const verifyCode = (username, code) => username === 'admin' && code === '123456';
  const logged = [];
  const logEvent = (event, entry) => logged.push({ event, ...entry });
  app.use('/certs', createClientCertRouter({ paths, listener, currentUser: () => ({ username: 'admin' }), verifyCode, logEvent }));
  app.get('/page', (_req, res) => res.send('ledger page'));

  const main = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => main.once('listening', resolve));
  const base = `http://127.0.0.1:${main.address().port}/certs`;
  const call = (path, method, body) => fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body)
  });
  const code = '123456';

  try {
    let state = await (await call('', 'GET')).json();
    assert.equal(state.ca.exists, false);
    assert.deepEqual(state.certificates, []);
    assert.equal(state.settings.enabled, false);

    // The authenticator code is required, and a certificate cannot be issued before the CA exists.
    assert.equal((await call('/ca', 'POST', { code: '000000' })).status, 403);
    assert.equal((await call('/certificates', 'POST', { code, name: 'early' })).status, 400);
    assert.equal((await call('/ca', 'POST', { code })).status, 201);
    assert.equal((await call('/ca', 'POST', { code })).status, 400, 'an existing CA is never overwritten');

    // Without HTTPS the port cannot open, and nothing is saved.
    const enable = { code, enabled: true, port: 18543, defaultDays: 90 };
    assert.equal((await call('/settings', 'PUT', enable)).status, 400);
    assert.equal(readClientCertSettings(paths).enabled, false);

    const serverDir = mkdtempSync(join(root, 'settings-server-'));
    execFileSync(openssl, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'server.key',
      '-out', 'server.crt', '-days', '2', '-subj', '/CN=localhost'], { cwd: serverDir, stdio: 'ignore' });
    listener.configure({
      tls: { key: readFileSync(join(serverDir, 'server.key')), cert: readFileSync(join(serverDir, 'server.crt')) },
      host: '127.0.0.1',
      reservedPorts: [3443]
    });
    assert.equal((await call('/settings', 'PUT', { ...enable, port: 3443 })).status, 400, 'the main port is reserved');
    assert.equal((await call('/settings', 'PUT', { ...enable, port: 80 })).status, 400);
    assert.equal((await call('/settings', 'PUT', { ...enable, code: '000000' })).status, 403);
    const opened = await call('/settings', 'PUT', enable);
    assert.equal(opened.status, 200);
    assert.equal((await opened.json()).listener.running, true);
    await assert.rejects(get(18543, { path: '/page' }), 'no certificate');

    // Issuing returns the file once, keeps no copy, and takes the default validity.
    assert.equal((await call('/certificates', 'POST', { code: '000000', name: '李四手机' })).status, 403);
    const issuedResponse = await call('/certificates', 'POST', { code, name: '李四手机' });
    assert.equal(issuedResponse.status, 201);
    assert.equal(issuedResponse.headers.get('cache-control'), 'no-store');
    const issued = await issuedResponse.json();
    assert.ok(new Date(issued.certificate.expiresAt) < new Date(Date.now() + 91 * 86400000));
    assert.ok(!readdirSync(dir).some((name) => name.endsWith('.p12') || name.startsWith('work-')));
    assert.ok(!readFileSync(paths.registry, 'utf8').includes(issued.password), 'the password is never stored');
    assert.equal((await call('/certificates', 'POST', { code, name: '李四手机' })).status, 400);

    const device = { path: '/page', pfx: Buffer.from(issued.p12, 'base64'), passphrase: issued.password };
    assert.deepEqual(await get(18543, device), { status: 200, body: 'ledger page' });

    // Through the certificate port everything can be read and nothing changed.
    const viaDevice = await get(18543, { ...device, path: '/certs' });
    assert.equal(JSON.parse(viaDevice.body).readOnly, true);
    assert.equal(await postViaDevice(18543, device, '/certs/ca'), 403);
    assert.equal(await postViaDevice(18543, device, `/certs/certificates/${issued.certificate.serial}/revoke`), 403);

    state = await (await call('', 'GET')).json();
    assert.equal(state.readOnly, false);
    assert.equal(state.certificates[0].state, 'active');
    assert.equal(state.certificates[0].issuedBy, 'admin');

    assert.equal((await call(`/certificates/${issued.certificate.serial}/revoke`, 'POST', {})).status, 200);
    assert.equal((await call(`/certificates/${issued.certificate.serial}/revoke`, 'POST', {})).status, 400);
    await assert.rejects(get(18543, device), 'revoked');
    state = await (await call('', 'GET')).json();
    assert.equal(state.certificates[0].state, 'revoked');

    // Closing takes effect at once and is remembered.
    const closed = await call('/settings', 'PUT', { ...enable, enabled: false });
    assert.equal((await closed.json()).listener.running, false);
    await assert.rejects(get(18543, device), /ECONNREFUSED/);
    assert.equal(readClientCertSettings(paths).defaultDays, 90);

    // Every change is logged with who and from where; wrong codes and read-only refusals are not changes.
    assert.deepEqual(logged.map((item) => item.event), ['ca_created', 'port_changed', 'cert_issued', 'cert_revoked', 'port_changed']);
    assert.ok(logged.every((item) => item.username === 'admin' && item.source.startsWith('ip:')));
    assert.match(logged[1].detail, /开启，端口 18543/);
    assert.match(logged[2].detail, /李四手机/);
    assert.ok(!JSON.stringify(logged).includes(issued.password), 'the password is never logged');
    assert.equal(readClientCertSettings(paths).enabled, false);
  } finally {
    await listener.stop();
    main.closeAllConnections();
    await new Promise((resolve) => main.close(resolve));
  }
});

test('connection guard limits each IP separately and frees slots on close', () => {
  let time = 0;
  const guard = createConnectionGuard({ maxPerIp: 2, perIpPerMinute: 3 }, () => time);
  assert.equal(guard.admit('a'), true);
  assert.equal(guard.admit('a'), true);
  assert.equal(guard.admit('a'), false, 'too many open at once');
  assert.equal(guard.admit('b'), true, 'another IP is unaffected');

  guard.release('a');
  assert.equal(guard.admit('a'), true);
  guard.release('a');
  assert.equal(guard.admit('a'), false, 'too many started within a minute');

  time += 61000;
  assert.equal(guard.admit('a'), true, 'the minute has passed');
});

test('the port is hardened against strangers and reveals little', { skip: !hasOpenssl }, async () => {
  const dir = mkdtempSync(join(root, 'hardened-'));
  assert.equal(run(dir, 'init').status, 0);
  const paths = clientCertPaths(dir);
  const caName = new crypto.X509Certificate(readFileSync(paths.caCert)).subject;
  assert.equal(caName, 'CN=Device CA', 'the name a stranger can read says nothing about the system');
  const device = issueDevice(dir, 'phone');
  // A fresh connection per request: the default agent would reuse one and skip the limit.
  const pfx = { pfx: device.pfx, passphrase: device.passphrase, agent: false };

  const serverDir = mkdtempSync(join(root, 'hardened-server-'));
  execFileSync(openssl, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'server.key',
    '-out', 'server.crt', '-days', '2', '-subj', '/CN=localhost'], { cwd: serverDir, stdio: 'ignore' });
  const server = createClientCertServer({
    app: (_req, res) => res.end('ok'),
    tls: { key: readFileSync(join(serverDir, 'server.key')), cert: readFileSync(join(serverDir, 'server.crt')) },
    paths,
    limits: { maxConnections: 50, maxPerIp: 3, perIpPerMinute: 20, handshakeTimeout: 300 }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const closed = (socket) => new Promise((resolve) => socket.once('close', resolve));

  try {
    // TLS 1.2 would show the device name to anyone on the network.
    await assert.rejects(get(port, { ...pfx, maxVersion: 'TLSv1.2' }), 'TLS 1.2 refused');
    assert.deepEqual(await get(port, pfx), { status: 200, body: 'ok' });

    // A connection that never starts its handshake does not hold a slot.
    const idle = net.connect(port, '127.0.0.1');
    const started = Date.now();
    await closed(idle);
    assert.ok(Date.now() - started < 3000, 'idle connection is dropped by the handshake timeout');

    // Beyond the per-IP limit a new connection is dropped before any TLS work.
    const held = [net.connect(port, '127.0.0.1'), net.connect(port, '127.0.0.1'), net.connect(port, '127.0.0.1')];
    await Promise.all(held.map((socket) => new Promise((resolve) => socket.once('connect', resolve))));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(get(port, pfx), 'over the per-IP limit');
    await Promise.all(held.map(closed));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await get(port, pfx)).status, 200, 'slots free up once those connections end');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('settings API reports a locked authenticator check as 429', async () => {
  const dir = mkdtempSync(join(root, 'locked-'));
  const paths = clientCertPaths(dir);
  const app = express();
  app.use(express.json());
  const locked = Object.assign(new Error('尝试次数过多，请 15 分钟后再试'), { status: 429 });
  const sources = [];
  const router = createClientCertRouter({
    paths,
    listener: createClientCertListener({ app, paths }),
    currentUser: () => ({ username: 'admin' }),
    verifyCode: (_username, _code, source) => {
      sources.push(source);
      throw locked;
    }
  });
  app.use('/certs', router);
  const main = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => main.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${main.address().port}/certs/ca`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"code":"123456"}'
    });
    assert.equal(response.status, 429);
    assert.match((await response.json()).error, /尝试次数过多/);
    assert.match(sources[0], /^ip:/);
    assert.equal(caExists(paths), false);
  } finally {
    main.closeAllConnections();
    await new Promise((resolve) => main.close(resolve));
  }
});

test('the CA is refused inside a cloud-synced folder', () => {
  const paths = clientCertPaths(join(root, 'OneDrive', 'certs'));
  assert.throws(() => initCa(paths), /云同步/);
  assert.equal(caExists(paths), false);
});

test('serial check allows only issued, unrevoked certificates and fails closed', () => {
  assert.equal(normalizeSerial('00:ab:Cd'), 'ABCD');
  const dir = mkdtempSync(join(root, 'serial-'));
  const check = createSerialCheck(join(dir, 'missing.json'));
  assert.equal(check('ABCD'), false);
  assert.equal(check(''), false);
});

test('device certificates open the port; missing, foreign and revoked ones do not', { skip: !hasOpenssl }, async () => {
  const dir = mkdtempSync(join(root, 'ca-'));
  assert.equal(run(dir, 'init').status, 0);
  assert.notEqual(run(dir, 'init').status, 0, 'init must not overwrite an existing CA');
  assert.notEqual(run(dir, 'issue', '../bad').status, 0);

  const phone = issueDevice(dir, '张三 手机');
  assert.notEqual(run(dir, 'issue', '张三 手机').status, 0, 'an active name cannot be issued twice');
  const other = issueDevice(dir, 'other-phone');
  assert.ok(!readdirSync(dir).some((name) => name.startsWith('work-')), 'no key material is left behind');

  // A certificate from another CA must not be accepted even with the same tools.
  const foreignDir = mkdtempSync(join(root, 'foreign-'));
  assert.equal(run(foreignDir, 'init').status, 0);
  const foreign = issueDevice(foreignDir, 'intruder');

  // Server certificate for the test listener.
  const serverDir = mkdtempSync(join(root, 'server-'));
  execFileSync(openssl, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'server.key',
    '-out', 'server.crt', '-days', '2', '-subj', '/CN=localhost'], { cwd: serverDir, stdio: 'ignore' });
  const server = createClientCertServer({
    app: (_req, res) => res.end('ok'),
    tls: { key: readFileSync(join(serverDir, 'server.key')), cert: readFileSync(join(serverDir, 'server.crt')) },
    paths: clientCertPaths(dir)
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await assert.rejects(get(port), 'no certificate');
    await assert.rejects(get(port, { pfx: foreign.pfx, passphrase: foreign.passphrase }), 'certificate from another CA');

    const device = { pfx: phone.pfx, passphrase: phone.passphrase };
    assert.deepEqual(await get(port, device), { status: 200, body: 'ok' });
    // A resumed TLS session still identifies the device.
    const resuming = new https.Agent({ keepAlive: false, maxCachedSessions: 10 });
    assert.equal((await get(port, { ...device, agent: resuming })).status, 200);
    assert.equal((await get(port, { ...device, agent: resuming })).status, 200);

    // Revoking cuts off a connection that is already open, without a restart.
    const keepAlive = new https.Agent({ keepAlive: true, maxSockets: 1 });
    assert.equal((await get(port, { ...device, agent: keepAlive })).status, 200);
    assert.equal(run(dir, 'revoke', phone.serial).status, 0);
    await assert.rejects(get(port, { ...device, agent: keepAlive }), 'revoked on an open connection');
    await assert.rejects(get(port, device), 'revoked on a new connection');
    keepAlive.destroy();
    resuming.destroy();

    const listed = run(dir, 'list').stdout;
    assert.match(listed, /已吊销.*张三 手机/);
    assert.match(listed, /有效.*other-phone/);
    assert.equal((await get(port, { pfx: other.pfx, passphrase: other.passphrase })).status, 200);

    // Without its record the port lets nobody in.
    const { registry } = clientCertPaths(dir);
    renameSync(registry, `${registry}.moved`);
    await assert.rejects(get(port, { pfx: other.pfx, passphrase: other.passphrase }), 'record missing');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
