import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentMail } from '../server/lib/agent-mail.js';
import { loadDefaultCc } from '../server/lib/mail-settings.js';

test('mail adapter uses direct arguments, plain UTF-8 body files and removes temporary reports', async () => {
  let folder;
  const body = '集团：测试集团\n总欠费：100.00 元\n$(echo unsafe)';
  const mail = createAgentMail({ defaultCc: () => ['audit@example.com'], binary: () => '/fake/agently', execute: async (binary, args, options) => {
    assert.equal(binary, '/fake/agently');
    if (args[0] === 'auth') return { stdout: JSON.stringify({ ok: true, data: { logged_in: true } }) };
    assert.equal(options.shell, undefined);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(args, ['message', '+send', '--to', 'manager@example.com', '--cc', 'audit@example.com', '--subject', '预警报告', '--body-file', './body.txt', '--body-format', 'plain', '--confirmed']);
    folder = options.cwd;
    assert.equal(readFileSync(join(folder, 'body.txt'), 'utf8'), body);
    return { stdout: JSON.stringify({ ok: true, data: { queued: true } }) };
  } });
  assert.deepEqual(await mail.status(), { available: true, loggedIn: true });
  assert.deepEqual(await mail.send({ recipient: 'manager@example.com', subject: '预警报告', body }), { queued: true });
  assert.equal(existsSync(folder), false);
});

test('mail adapter distinguishes failed authorization from uncertain sends and never retries', async () => {
  for (const [response, code, uncertain] of [
    [JSON.stringify({ error: { message: 'Authorization expired' } }), 3, false],
    [JSON.stringify({ error: { message: 'Network interrupted' } }), 4, true]
  ]) {
    let calls = 0;
    const mail = createAgentMail({ defaultCc: () => ['audit@example.com'], binary: () => '/fake/agently', execute: async () => { calls++; throw Object.assign(new Error('failed'), { stdout: response, code }); } });
    await assert.rejects(mail.send({ recipient: 'manager@example.com', subject: '报告', body: '报告' }), (error) => error.uncertain === uncertain);
    assert.equal(calls, 1);
    assert.deepEqual(await mail.status(), { available: false, loggedIn: false });
  }
  for (const stdout of ['not JSON', JSON.stringify({ ok: false, error: { message: 'Rejected' } }), JSON.stringify({ ok: true, data: { confirmation_required: true } })]) {
    const mail = createAgentMail({ defaultCc: () => ['audit@example.com'], binary: () => '/fake/agently', execute: async () => ({ stdout }) });
    await assert.rejects(mail.send({ recipient: 'manager@example.com', subject: '报告', body: '报告' }), (error) => error.uncertain === true);
  }
  const loggedOut = createAgentMail({ binary: () => '/fake/agently', execute: async () => ({ stdout: JSON.stringify({ ok: true, data: { logged_in: false } }) }) });
  assert.deepEqual(await loggedOut.status(), { available: true, loggedIn: false });
});

test('private CC configuration is required, validated and included on every send', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mail-settings-test-'));
  const settingsFile = join(folder, 'settings.json');
  try {
    writeFileSync(settingsFile, JSON.stringify({ defaultCc: ['audit@example.com', ' AUDIT@example.com '] }));
    assert.deepEqual(loadDefaultCc({ settingsFile }), ['AUDIT@example.com']);
    assert.deepEqual(loadDefaultCc({ settingsFile, cc: 'copy@example.com; other@example.com' }), ['copy@example.com', 'other@example.com']);
    for (const cc of ['', 'bad', 'a@example.com\nother@example.com']) assert.throws(() => loadDefaultCc({ cc }));
    assert.throws(() => loadDefaultCc({ settingsFile: join(folder, 'missing.json') }));
    let called = false;
    const mail = createAgentMail({ defaultCc: () => ['audit@example.com'], execute: async () => { called = true; } });
    await assert.rejects(mail.send({ recipient: 'manager@example.com', cc: ['changed@example.com'], subject: '报告', body: '报告' }), (error) => error.uncertain === false);
    assert.equal(called, false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
