import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadDefaultCc({
  settingsFile = process.env.AGENT_MAIL_SETTINGS_FILE || fileURLToPath(new URL('../../data/mail-settings.json', import.meta.url)),
  cc = process.env.WARNING_MAIL_CC
} = {}) {
  try {
    const values = cc === undefined ? JSON.parse(readFileSync(settingsFile, 'utf8')).defaultCc : cc.split(/[;,]/);
    if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string')) throw new Error('invalid');
    const result = [...new Map(values.map((value) => value.trim()).map((value) => [value.toLowerCase(), value])).values()];
    if (result.some((value) => value.length > 254 || !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(value))) throw new Error('invalid');
    return result;
  } catch {
    const error = new Error('默认抄送邮箱未配置或配置无效，请检查服务器邮件配置');
    error.uncertain = false;
    throw error;
  }
}
