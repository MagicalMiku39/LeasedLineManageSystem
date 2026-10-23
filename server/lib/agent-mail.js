import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDefaultCc } from './mail-settings.js';

const require = createRequire(import.meta.url);

export function createAgentMail({ execute = promisify(execFile), binary = () => require('@tencent-qqmail/agently-cli/scripts/run.js').getBinaryPath(), defaultCc = loadDefaultCc } = {}) {
  async function invoke(args, cwd) {
    let stdout;
    try {
      ({ stdout } = await execute(binary(), args, {
        cwd, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024
      }));
    } catch (error) {
      let message = '邮箱调用失败，请检查运行系统的账户是否已完成邮箱授权';
      try { message = JSON.parse(error.stdout).error?.message || message; } catch { /* No JSON output on launch failure. */ }
      const result = new Error(message);
      result.uncertain = ![2, 3, 6, 8, 'ENOENT', 'MODULE_NOT_FOUND'].includes(error.code);
      throw result;
    }
    let envelope;
    try { envelope = JSON.parse(stdout); } catch {
      const error = new Error('邮箱返回结果无法确认，请在邮箱管理端检查发送记录');
      error.uncertain = true;
      throw error;
    }
    if (envelope.ok !== true) {
      const error = new Error(envelope.error?.message || '邮箱操作失败');
      error.uncertain = true;
      throw error;
    }
    return envelope.data;
  }

  return {
    defaultCc,
    async status() {
      try {
        const data = await invoke(['auth', 'status']);
        return { available: true, loggedIn: data?.logged_in === true };
      } catch {
        return { available: false, loggedIn: false };
      }
    },
    async send({ recipient, cc, subject, body }) {
      const copies = defaultCc();
      if (cc && JSON.stringify(cc) !== JSON.stringify(copies)) {
        const error = new Error('默认抄送配置已变更，请重新预览报告');
        error.uncertain = false;
        throw error;
      }
      const folder = await mkdtemp(join(tmpdir(), 'ledger-warning-mail-'));
      try {
        await writeFile(join(folder, 'body.txt'), body, { encoding: 'utf8', mode: 0o600 });
        const data = await invoke(['message', '+send', '--to', recipient, ...copies.flatMap((email) => ['--cc', email]), '--subject', subject,
          '--body-file', './body.txt', '--body-format', 'plain', '--confirmed'], folder);
        if (data?.queued !== true) {
          const error = new Error('邮件未返回提交成功，请在邮箱管理端核实发送状态');
          error.uncertain = true;
          throw error;
        }
        return { queued: true };
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    }
  };
}

export const agentMail = createAgentMail();
