// Command-line counterpart of 设置 → 设备证书, for use on the server when the page is out of reach.
//
//   node server/scripts/client-cert.js init
//   node server/scripts/client-cert.js issue <设备名> [--days 365]
//   node server/scripts/client-cert.js list
//   node server/scripts/client-cert.js revoke <设备名或序列号>
//
// Files go to CLIENT_CERT_DIR (default certs/client).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientCertPaths } from '../lib/client-cert.js';
import {
  ClientCertError,
  initCa,
  issueCertificate,
  listCertificates,
  readClientCertSettings,
  revokeCertificate
} from '../lib/client-cert-admin.js';

const paths = clientCertPaths();

function init() {
  initCa(paths);
  console.log(`已创建设备证书 CA：${paths.dir}`);
}

function issue(name, days) {
  const { certificate, p12, password } = issueCertificate(paths, { name, days });
  mkdirSync(paths.issuedDir, { recursive: true });
  const output = join(paths.issuedDir, `${certificate.name.replaceAll(' ', '_')}-${certificate.serial.slice(0, 8)}.p12`);
  writeFileSync(output, p12, { mode: 0o600 });
  console.log(`设备：${certificate.name}\n序列号：${certificate.serial}\n有效至：${certificate.expiresAt.slice(0, 10)}\n证书文件：${output}\n导入密码：${password}`);
  console.log('\n密码只显示这一次，不会保存。请把文件和密码分开发送，手机导入后删除这个文件。');
}

const stateLabels = { active: '有效', expired: '已过期', revoked: '已吊销' };

function list() {
  const certificates = listCertificates(paths);
  if (certificates.length === 0) {
    console.log('还没有签发设备证书');
    return;
  }
  for (const item of certificates) {
    console.log(`${stateLabels[item.state]}\t${item.name}\t有效至 ${item.expiresAt.slice(0, 10)}\t${item.serial}`);
  }
}

function revoke(target) {
  if (!target) throw new ClientCertError('请提供设备名或序列号');
  const certificate = revokeCertificate(paths, target);
  console.log(`已吊销：${certificate.name}（${certificate.serial}）。无需重启，下一个请求起生效。`);
}

const [command, target, flag, value] = process.argv.slice(2);
try {
  switch (command) {
    case 'init':
      init();
      break;
    case 'issue':
      issue(target, flag === '--days' ? Number(value) : readClientCertSettings(paths).defaultDays);
      break;
    case 'list':
      list();
      break;
    case 'revoke':
      revoke(target);
      break;
    default:
      throw new ClientCertError('用法：client-cert.js init | issue <设备名> [--days 365] | list | revoke <设备名或序列号>');
  }
} catch (error) {
  console.error(error instanceof ClientCertError ? error.message : error);
  process.exit(1);
}
