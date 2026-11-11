export const securityLogCategories = [
  { value: '', label: '全部事件' },
  { value: 'login', label: '登录' },
  { value: 'account', label: '修改密码' },
  { value: 'code', label: '设置页验证码' },
  { value: 'cert', label: '证书与端口' },
  { value: 'backup', label: '数据备份' }
];

export const securityEventLabels = {
  login_success: '登录成功',
  login_failed: '登录失败',
  login_locked: '登录已锁定',
  password_changed: '修改密码',
  password_change_failed: '修改密码失败',
  code_failed: '验证码错误',
  code_locked: '验证码已锁定',
  ca_created: '创建证书机构',
  port_changed: '修改端口设置',
  cert_issued: '签发证书',
  cert_revoked: '吊销证书',
  backup_created: '手动备份',
  backup_downloaded: '下载备份',
  backup_restored: '回退数据'
};

const alertEvents = new Set(['login_failed', 'login_locked', 'code_failed', 'code_locked', 'password_change_failed']);

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

