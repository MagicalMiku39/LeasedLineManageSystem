import express from 'express';
import cors from 'cors';
import multer from 'multer';
import XLSX from 'xlsx';
import http from 'node:http';
import https from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { db, nowIso } from './lib/db.js';
import { editableFields } from './lib/field-map.js';
import { importExcel } from './lib/import-excel.js';
import {
  authStatus,
  currentUser,
  loginAuth,
  logoutAuth,
  requireAuth,
  setupAuth
} from './lib/auth.js';

const app = express();
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '0.0.0.0';
const httpsKeyFile = process.env.HTTPS_KEY_FILE || '';
const httpsCertFile = process.env.HTTPS_CERT_FILE || '';
const httpsPfxFile = process.env.HTTPS_PFX_FILE || '';
const httpsPfxPassphrase = process.env.HTTPS_PFX_PASSPHRASE || '';
const httpsEnabled = Boolean(httpsPfxFile || (httpsKeyFile && httpsCertFile));
const uploadDir = join(process.cwd(), 'uploads');
const distDir = join(process.cwd(), 'dist');

if (httpsEnabled && process.env.AUTH_COOKIE_SECURE === undefined) {
  process.env.AUTH_COOKIE_SECURE = 'true';
}

mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir });

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/auth/status', (req, res) => {
  res.json({ ...authStatus(), user: currentUser(req) });
});

app.post('/api/auth/setup', (req, res) => {
  try {
    res.json(setupAuth(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const result = loginAuth(req.body || {});
    res.setHeader('Set-Cookie', result.cookie);
    res.json({ user: result.user });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  logoutAuth(req, res);
  res.json({ ok: true });
});

app.use('/api', requireAuth);

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const amountFields = new Set([
  'actual_monthly_fee',
  'actual_yearly_fee',
  'one_time_fee'
]);

const originalLedgerColumns = [
  'group_code',
  'group_name',
  'node_code',
  'node_name',
  'region_name',
  'group_product_code',
  'group_user_name',
  'group_product_account_id',
  'payment_method',
  'payment_method_name',
  'product_code',
  'product_name',
  'product_category',
  'start_time',
  'end_time',
  'status_time',
  'product_status',
  'product_status_name',
  'is_group_tagged',
  'group_level',
  'industry_code_1',
  'industry_name_1',
  'industry_code_2',
  'industry_name_2',
  'manager_job_no',
  'manager_name',
  'total_arrears',
  'source_created_time',
  'last_month_status',
  'two_months_ago_status',
  'bandwidth',
  'is_zero_billing_recent_6m',
  'package_code',
  'package_name',
  'package_fee',
  'package_effective_time',
  'package_expire_time',
  'a_end_address',
  'z_end_address'
];

const manualLedgerColumns = [
  'actual_monthly_fee',
  'actual_yearly_fee',
  'one_time_fee',
  'one_time_fee_name',
  'one_time_fee_billing_month',
  'contract_no',
  'contract_start_date',
  'contract_end_date',
  'renewal_status',
  'renewal_reminder_date',
  'customer_contact',
  'customer_phone',
  'operation_owner',
  'business_owner',
  'project_name',
  'ledger_status',
  'remark',
  'updated_at'
];

const normalStatus = '正常在用';
const stoppingStatus = '停机执行中';
const stoppedStatus = '停机';
const addedStatuses = [normalStatus, stoppingStatus, stoppedStatus];
const cancelledStatuses = ['欠费销户', '正式销户', '销户(订单处理中)', '销户（订单处理中）'];

function monthRange(month) {
  const normalized = String(month || new Date().toISOString().slice(0, 7)).slice(0, 7);
  const monthStart = `${normalized}-01`;
  const nextMonth = new Date(`${monthStart}T00:00:00`);
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  return {
    month: normalized,
    monthStart,
    nextMonthStart: nextMonth.toISOString().slice(0, 10)
  };
}

function buildLedgerWhere(query) {
  const where = [];
  const params = [];

  if (query.keyword) {
    const keyword = `%${query.keyword.trim()}%`;
    where.push(`(
      group_code LIKE ? OR group_name LIKE ? OR group_product_code LIKE ? OR product_code LIKE ? OR
      group_user_name LIKE ? OR group_product_account_id LIKE ? OR product_name LIKE ? OR
      manager_name LIKE ? OR a_end_address LIKE ? OR z_end_address LIKE ?
    )`);
    params.push(keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword);
  }

  const exactFilters = {
    region: 'region_name',
    product: 'product_name',
    category: 'product_category',
    status: 'product_status_name',
    manager: 'manager_name',
    ledgerStatus: 'ledger_status'
  };

  for (const [key, column] of Object.entries(exactFilters)) {
    if (query[key]) {
      where.push(`${column} = ?`);
      params.push(query[key]);
    }
  }

  const likeFilters = {
    groupCode: 'group_code',
    groupProductCode: 'group_product_code',
    productCode: 'product_code',
    bandwidth: 'bandwidth'
  };

  for (const [key, column] of Object.entries(likeFilters)) {
    if (query[key]) {
      where.push(`${column} LIKE ?`);
      params.push(`%${query[key].trim()}%`);
    }
  }

  if (query.zeroBilling) {
    where.push('is_zero_billing_recent_6m = ?');
    params.push(query.zeroBilling);
  }

  if (query.contractEndFrom) {
    where.push('contract_end_date >= ?');
    params.push(query.contractEndFrom);
  }

  if (query.contractEndTo) {
    where.push('contract_end_date <= ?');
    params.push(query.contractEndTo);
  }

  if (query.statFilter) {
    const { monthStart, nextMonthStart } = monthRange(query.statMonth);
    if (query.statFilter === 'active') {
      where.push('COALESCE(product_status_name, ledger_status, \'\') = ?');
      params.push(normalStatus);
    } else if (query.statFilter === 'cancelled') {
      where.push(`COALESCE(product_status_name, ledger_status, '') IN (${cancelledStatuses.map(() => '?').join(', ')})`);
      params.push(...cancelledStatuses);
    } else if (query.statFilter === 'addedInMonth') {
      where.push(`start_time >= ? AND start_time < ? AND COALESCE(product_status_name, ledger_status, '') IN (${addedStatuses.map(() => '?').join(', ')})`);
      params.push(monthStart, nextMonthStart, ...addedStatuses);
    } else if (query.statFilter === 'cancelledInMonth') {
      where.push(`status_time >= ? AND status_time < ? AND COALESCE(product_status_name, ledger_status, '') IN (${cancelledStatuses.map(() => '?').join(', ')})`);
      params.push(monthStart, nextMonthStart, ...cancelledStatuses);
    } else if (query.statFilter === 'stoppedInMonth') {
      where.push('status_time >= ? AND status_time < ? AND COALESCE(product_status_name, ledger_status, \'\') = ?');
      params.push(monthStart, nextMonthStart, stoppedStatus);
    }
  }

  return {
    sql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    params
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: nowIso() });
});

app.post('/api/import', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: '请上传 Excel 文件' });
    return;
  }

  try {
    const result = importExcel(req.file.path, req.file.originalname);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/imports', (_req, res) => {
  const rows = db.prepare('SELECT * FROM import_batch ORDER BY imported_at DESC LIMIT 30').all();
  res.json(rows);
});

app.get('/api/imports/:id/rows', (req, res) => {
  const rows = db.prepare(
    `SELECT row_number, result, message, related_line_id
     FROM import_row_log
     WHERE batch_id = ?
     ORDER BY row_number ASC
     LIMIT 100`
  ).all(req.params.id);
  res.json(rows);
});

app.get('/api/ledger', (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 20)));
  const offset = (page - 1) * pageSize;
  const where = buildLedgerWhere(req.query);

  const total = db.prepare(`SELECT COUNT(*) AS count FROM leased_line ${where.sql}`).get(...where.params).count;
  const rows = db.prepare(
    `SELECT
      id, ${[...originalLedgerColumns, ...manualLedgerColumns].join(', ')}
     FROM leased_line
     ${where.sql}
     ORDER BY updated_at DESC, id DESC
     LIMIT ? OFFSET ?`
  ).all(...where.params, pageSize, offset);

  res.json({ rows, page, pageSize, total });
});

const exportColumns = [
  ['集团编码', 'group_code'],
  ['集团名称', 'group_name'],
  ['归属节点', 'node_code'],
  ['节点名称', 'node_name'],
  ['归属区分', 'region_name'],
  ['集团产品编码', 'group_product_code'],
  ['集团用户名称', 'group_user_name'],
  ['集团产品账户ID', 'group_product_account_id'],
  ['付费方式', 'payment_method'],
  ['付费方式名称', 'payment_method_name'],
  ['产品编码', 'product_code'],
  ['产品名称', 'product_name'],
  ['产品大类', 'product_category'],
  ['开始时间', 'start_time'],
  ['结束时间', 'end_time'],
  ['状态时间', 'status_time'],
  ['产品状态', 'product_status'],
  ['产品状态名称', 'product_status_name'],
  ['集团是否打标', 'is_group_tagged'],
  ['集团级别', 'group_level'],
  ['集团行业类别1', 'industry_code_1'],
  ['行业类别名称1', 'industry_name_1'],
  ['集团行业类别2', 'industry_code_2'],
  ['行业类别名称2', 'industry_name_2'],
  ['客户经理工号', 'manager_job_no'],
  ['客户经理名称', 'manager_name'],
  ['总欠费', 'total_arrears'],
  ['创建时间', 'source_created_time'],
  ['上月状态', 'last_month_status'],
  ['上上月状态', 'two_months_ago_status'],
  ['专线带宽', 'bandwidth'],
  ['最近半年是否出账为0', 'is_zero_billing_recent_6m'],
  ['活动套餐', 'package_code'],
  ['活动套餐名称', 'package_name'],
  ['活动套餐资费', 'package_fee'],
  ['活动套餐生效时间', 'package_effective_time'],
  ['活动套餐失效时间', 'package_expire_time'],
  ['A端地址', 'a_end_address'],
  ['Z端地址', 'z_end_address'],
  ['实际月资费', 'actual_monthly_fee'],
  ['实际年资费', 'actual_yearly_fee'],
  ['单次出账费用', 'one_time_fee'],
  ['单次费用名称', 'one_time_fee_name'],
  ['单次费用出账月份', 'one_time_fee_billing_month'],
  ['合同编号', 'contract_no'],
  ['合同期开始', 'contract_start_date'],
  ['合同期结束', 'contract_end_date'],
  ['是否续约', 'renewal_status'],
  ['续约提醒日期', 'renewal_reminder_date'],
  ['客户联系人', 'customer_contact'],
  ['联系电话', 'customer_phone'],
  ['运维负责人', 'operation_owner'],
  ['商务负责人', 'business_owner'],
  ['项目归属', 'project_name'],
  ['台账状态', 'ledger_status'],
  ['备注', 'remark']
];

app.get('/api/ledger/export', (req, res) => {
  const where = buildLedgerWhere(req.query);
  const rows = db.prepare(
    `SELECT ${exportColumns.map(([, column]) => column).join(', ')}
     FROM leased_line
     ${where.sql}
     ORDER BY updated_at DESC, id DESC`
  ).all(...where.params);

  const data = rows.map((row) => {
    const item = {};
    for (const [label, column] of exportColumns) {
      item[label] = row[column] ?? '';
    }
    return item;
  });

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(workbook, worksheet, '台账导出');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const filename = `leased-line-export-${new Date().toISOString().slice(0, 10)}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

app.patch('/api/ledger/batch', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) {
    res.status(400).json({ error: '请选择需要批量更新的记录' });
    return;
  }

  const updates = {};
  for (const field of editableFields) {
    if (Object.hasOwn(req.body.values || {}, field) && req.body.values[field] !== '') {
      updates[field] = amountFields.has(field) ? numberOrNull(req.body.values[field]) : req.body.values[field] || null;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: '没有可批量更新的字段' });
    return;
  }

  updates.updated_at = nowIso();
  const columns = Object.keys(updates);
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  const update = db.prepare(`UPDATE leased_line SET ${assignments} WHERE id = ?`);
  const log = db.prepare(
    `INSERT INTO change_log (leased_line_id, field_name, old_value, new_value, changed_by, change_source)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const existing = db.prepare('SELECT * FROM leased_line WHERE id = ?').get(id);
      if (!existing) continue;
      update.run(...columns.map((column) => updates[column]), id);
      for (const [field, value] of Object.entries(updates)) {
        if (field === 'updated_at') continue;
        if (String(existing[field] ?? '') !== String(value ?? '')) {
          log.run(id, field, existing[field] ?? null, value ?? null, 'admin', 'batch');
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ updated: ids.length });
});

app.get('/api/ledger/:id/logs', (req, res) => {
  const logs = db.prepare(
    `SELECT id, field_name, old_value, new_value, changed_by, changed_at, change_source
     FROM change_log
     WHERE leased_line_id = ?
     ORDER BY changed_at DESC, id DESC
     LIMIT 50`
  ).all(req.params.id);
  res.json(logs);
});

app.get('/api/ledger/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM leased_line WHERE id = ?').get(req.params.id);
  if (!row) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  res.json(row);
});

app.patch('/api/ledger/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM leased_line WHERE id = ?').get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }

  const updates = {};
  for (const field of editableFields) {
    if (Object.hasOwn(req.body, field)) {
      updates[field] = amountFields.has(field) ? numberOrNull(req.body[field]) : req.body[field] || null;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: '没有可更新字段' });
    return;
  }

  updates.updated_at = nowIso();
  const columns = Object.keys(updates);
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  db.prepare(`UPDATE leased_line SET ${assignments} WHERE id = ?`).run(...columns.map((column) => updates[column]), req.params.id);

  const log = db.prepare(
    `INSERT INTO change_log (leased_line_id, field_name, old_value, new_value, changed_by, change_source)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const [field, value] of Object.entries(updates)) {
    if (field === 'updated_at') continue;
    if (String(existing[field] ?? '') !== String(value ?? '')) {
      log.run(req.params.id, field, existing[field] ?? null, value ?? null, 'admin', 'manual');
    }
  }

  res.json(db.prepare('SELECT * FROM leased_line WHERE id = ?').get(req.params.id));
});

app.get('/api/options', (_req, res) => {
  const optionFields = {
    regions: 'region_name',
    products: 'product_name',
    categories: 'product_category',
    statuses: 'product_status_name',
    managers: 'manager_name',
    ledgerStatuses: 'ledger_status',
    bandwidths: 'bandwidth',
    zeroBillingOptions: 'is_zero_billing_recent_6m'
  };
  const result = {};
  for (const [key, column] of Object.entries(optionFields)) {
    result[key] = db.prepare(
      `SELECT DISTINCT ${column} AS value FROM leased_line
       WHERE ${column} IS NOT NULL AND ${column} <> ''
       ORDER BY ${column} LIMIT 200`
    ).all().map((row) => row.value);
  }
  res.json(result);
});

app.get('/api/stats', (req, res) => {
  const { month, monthStart, nextMonthStart } = monthRange(req.query.month);
  const addedPlaceholders = addedStatuses.map(() => '?').join(', ');
  const cancelledPlaceholders = cancelledStatuses.map(() => '?').join(', ');

  const total = db.prepare('SELECT COUNT(*) AS count FROM leased_line').get().count;
  const active = db.prepare(
    `SELECT COUNT(*) AS count FROM leased_line
     WHERE COALESCE(ledger_status, product_status_name, '') LIKE '%在用%'`
  ).get().count;
  const cancelled = db.prepare(
    `SELECT COUNT(*) AS count FROM leased_line
     WHERE COALESCE(ledger_status, product_status_name, '') LIKE '%销户%'`
  ).get().count;
  const addedInMonth = db.prepare(
    `SELECT COUNT(*) AS count FROM leased_line
     WHERE start_time >= ? AND start_time < ?
       AND COALESCE(product_status_name, ledger_status, '') IN (${addedPlaceholders})`
  ).get(monthStart, nextMonthStart, ...addedStatuses).count;
  const cancelledInMonth = db.prepare(
    `SELECT COUNT(*) AS count FROM leased_line
     WHERE status_time >= ? AND status_time < ?
       AND COALESCE(product_status_name, ledger_status, '') IN (${cancelledPlaceholders})`
  ).get(monthStart, nextMonthStart, ...cancelledStatuses).count;
  const stoppedInMonth = db.prepare(
    `SELECT COUNT(*) AS count FROM leased_line
     WHERE status_time >= ? AND status_time < ?
       AND COALESCE(product_status_name, ledger_status, '') = ?`
  ).get(monthStart, nextMonthStart, stoppedStatus).count;
  const expectedMonthlyBilling = db.prepare(
    `SELECT COALESCE(SUM(
       CASE
         WHEN COALESCE(product_status_name, ledger_status, '') = ?
           THEN CASE WHEN COALESCE(actual_monthly_fee, 0) > 0 THEN actual_monthly_fee ELSE COALESCE(package_fee, 0) END
         WHEN COALESCE(product_status_name, ledger_status, '') IN (?, ?)
           AND status_time >= ? AND status_time < ?
           THEN CASE WHEN COALESCE(actual_monthly_fee, 0) > 0 THEN actual_monthly_fee ELSE COALESCE(package_fee, 0) END
         ELSE 0
       END
     ), 0) AS amount
     FROM leased_line
     WHERE COALESCE(product_status_name, ledger_status, '') IN (${addedPlaceholders})`
  ).get(normalStatus, stoppingStatus, stoppedStatus, monthStart, nextMonthStart, ...addedStatuses).amount;
  const expectedOneTimeBilling = db.prepare(
    `SELECT COALESCE(SUM(
       CASE
         WHEN start_time >= ? AND start_time < ?
           AND (
             COALESCE(product_status_name, ledger_status, '') = ?
             OR (
               COALESCE(product_status_name, ledger_status, '') IN (?, ?)
               AND status_time >= ? AND status_time < ?
             )
           )
           THEN COALESCE(one_time_fee, 0)
         ELSE 0
       END
     ), 0) AS amount
     FROM leased_line
     WHERE COALESCE(product_status_name, ledger_status, '') IN (${addedPlaceholders})`
  ).get(
    monthStart,
    nextMonthStart,
    normalStatus,
    stoppingStatus,
    stoppedStatus,
    monthStart,
    nextMonthStart,
    ...addedStatuses
  ).amount;

  const byProduct = db.prepare(
    `SELECT COALESCE(product_name, '未填写') AS name, COUNT(*) AS count
     FROM leased_line GROUP BY COALESCE(product_name, '未填写')
     ORDER BY count DESC LIMIT 8`
  ).all();

  res.json({
    month,
    total,
    active,
    cancelled,
    addedInMonth,
    cancelledInMonth,
    stoppedInMonth,
    expectedMonthlyBilling,
    expectedOneTimeBilling,
    expectedTotalBilling: expectedMonthlyBilling + expectedOneTimeBilling,
    byProduct
  });
});

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(join(distDir, 'index.html'));
  });
}

if (httpsEnabled) {
  const httpsOptions = httpsPfxFile
    ? { pfx: readFileSync(httpsPfxFile), passphrase: httpsPfxPassphrase }
    : { key: readFileSync(httpsKeyFile), cert: readFileSync(httpsCertFile) };
  const server = https.createServer(httpsOptions, app);

  server.listen(port, host, () => {
    console.log(`HTTPS server listening on https://${host}:${port}`);
  });

  if (process.env.HTTP_REDIRECT_PORT) {
    const redirectPort = Number(process.env.HTTP_REDIRECT_PORT);
    http.createServer((req, res) => {
      const hostname = String(req.headers.host || '').split(':')[0] || 'localhost';
      res.writeHead(301, { Location: `https://${hostname}:${port}${req.url || '/'}` });
      res.end();
    }).listen(redirectPort, host, () => {
      console.log(`HTTP redirect listening on http://${host}:${redirectPort}`);
    });
  }
} else {
  app.listen(port, host, () => {
    console.log(`HTTP server listening on http://${host}:${port}`);
  });
}
