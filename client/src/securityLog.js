export const securityLogCategories = [
  { value: '', label: '全部事件' },
  { value: 'login', label: '登录' },
  { value: 'account', label: '修改密码' },
  { value: 'code', label: '设置页验证码' },
  { value: 'cert', label: '证书与端口' },
  { value: 'backup', label: '数据备份' },
  { value: 'share', label: '填报链接' }
];

export const securityEventLabels = {
  login_success: '登录成功',
  login_failed: '登录失败',
  login_locked: '登录已锁定',
  password_changed: '修改密码',
  password_change_failed: '修改密码失败',
  code_failed: '验证码错误',
  code_locked: '验证码已锁定',
  code_reused: '重复使用验证码',
  ca_created: '创建证书机构',
  port_changed: '修改端口设置',
  fill_port_changed: '修改填报端口',
  cert_issued: '签发证书',
  cert_revoked: '吊销证书',
  backup_created: '手动备份',
  backup_downloaded: '下载备份',
  backup_restored: '回退数据',
  share_created: '生成填报链接',
  share_revoked: '作废填报链接',
  share_submitted: '通过链接填报',
  share_opened: '打开填报链接',
  share_opened_new: '从新地址打开填报链接',
  share_opened_many: '填报链接被多个地址打开',
  share_bad_token: '无效填报链接',
  share_blocked: '无效链接过多已拦截',
  share_denied: '使用失效的填报链接'
};

const alertEvents = new Set([
  'login_failed', 'login_locked', 'code_failed', 'code_locked', 'code_reused', 'password_change_failed',
  'share_bad_token', 'share_blocked', 'share_denied', 'share_opened_many'
]);

// How each alert reads in the line shown after signing in.
const alertPhrases = {
  login_failed: (count) => `登录失败 ${count} 次`,
  login_locked: (count) => `登录被锁定 ${count} 次`,
  code_failed: (count) => `验证码错误 ${count} 次`,
  code_locked: (count) => `验证码被锁定 ${count} 次`,
  code_reused: (count) => `验证码被重复使用 ${count} 次`,
  password_change_failed: (count) => `修改密码失败 ${count} 次`,
  share_bad_token: (count) => `无效填报链接尝试 ${count} 次`,
  share_blocked: (count) => `因无效链接过多拦截 ${count} 次`,
  share_denied: (count) => `失效的填报链接被使用 ${count} 次`,
  share_opened_many: (count) => `填报链接被多个地址打开 ${count} 次`
};

/** One sentence for the events since the last login, or '' when there is nothing to say. */
export function alertSummaryText(summary, sinceText) {
  const parts = (summary?.items || []).filter((item) => alertPhrases[item.event]).map((item) => alertPhrases[item.event](item.count));
  if (!parts.length) return '';
  return `${sinceText ? `上次登录（${sinceText}）以来` : '近期'}：${parts.join('，')}。`;
}

export function isAlertEvent(event) {
  return alertEvents.has(event);
}

/** A source reads as the device name when its certificate is known, otherwise as an address. */
export function describeSource(source, certificates = []) {
  if (!source) return '—';
  if (source.startsWith('ip:')) return source.slice(3).replace(/^::ffff:/, '');
  if (source.startsWith('cert:')) {
    const serial = source.slice(5);
    const known = certificates.find((item) => item.serial.replace(/^0+/, '').toUpperCase() === serial);
    return known ? `设备 ${known.name}` : `设备证书 ${serial.slice(0, 8)}`;
  }
  return source;
}

