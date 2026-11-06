import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import XLSX from './xlsx.js';
import { billableStatuses, cancelledStatuses } from './ledger-rules.js';

const maxUploadMb = 32;
const previewMinutes = 15;
const headerSearchRows = 10;

// Column names the strategic customer list may use; the first one found wins.
const columnAliases = {
  group_code: ['集团编码', '集团编号', '集团代码', '集团客户编码', '集团客户编号', '集团ID', '客户编码'],
  group_name: ['集团名称', '集团客户名称', '客户名称', '单位名称'],
  manager_name: ['客户经理', '客户经理名称', '客户经理姓名', '归属客户经理']
};

const requiredLabels = { group_code: '集团编码', group_name: '集团名称', manager_name: '客户经理' };
const templateRows = 1000;
const shownIncompleteRows = 20;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

/**
 * Reads a strategic customer list: one row per group, found by its 集团编码 column wherever the
 * header row sits in the first rows. 集团编码, 集团名称 and 客户经理 must all be filled in; rows
 * missing any of them are reported by their Excel row number and not kept. Codes are text, so
 * leading zeros stay. Duplicates keep the first row.
 */
export function parseStrategicWorkbook(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch {
    throw new Error('无法读取 Excel 文件，请检查文件是否损坏或加密');
  }
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet['!ref']) continue;
    const firstRow = XLSX.utils.decode_range(sheet['!ref']).s.r;
    const cells = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true });
    const headerIndex = cells.slice(0, headerSearchRows).findIndex((row) => row.some((cell) => columnAliases.group_code.includes(clean(cell))));
    if (headerIndex < 0) continue;
    const headers = cells[headerIndex].map(clean);
    const position = Object.fromEntries(Object.entries(columnAliases).map(([field, aliases]) => [field, headers.findIndex((name) => aliases.includes(name))]));
    const absent = Object.keys(requiredLabels).filter((field) => position[field] < 0).map((field) => `“${requiredLabels[field]}”`);
    if (absent.length) throw new Error(`战客清单缺少${absent.join('、')}列，请下载模板按模板填写`);
    const rows = [];
    const seen = new Set();
    const incompleteRows = [];
    let incomplete = 0;
    let duplicates = 0;
    cells.slice(headerIndex + 1).forEach((row, index) => {
      if (!row.some((cell) => clean(cell))) return;
      const values = {
        group_code: clean(row[position.group_code]),
        group_name: String(row[position.group_name] ?? '').trim(),
        manager_name: clean(row[position.manager_name])
      };
      const missing = Object.keys(requiredLabels).filter((field) => !values[field]).map((field) => requiredLabels[field]);
      if (missing.length) {
        incomplete += 1;
        if (incompleteRows.length < shownIncompleteRows) incompleteRows.push({ row: firstRow + headerIndex + index + 2, missing });
        return;
      }
      if (seen.has(values.group_code)) {
        duplicates += 1;
        return;
      }
      seen.add(values.group_code);
      rows.push(values);
    });
    return {
      sheetName,
      rows,
      incomplete,
      incompleteRows,
      duplicates,
      columns: Object.fromEntries(Object.entries(position).map(([field, index]) => [field, headers[index]]))
    };
  }
  throw new Error('没有找到“集团编码”列，请下载模板按模板填写');
}

/**
 * The import template: the three required columns, with 集团编码 formatted as text so Excel keeps
 * leading zeros, and a sheet explaining the rules. It holds no sample groups.
 */
export function strategicTemplate() {
  const list = XLSX.utils.aoa_to_sheet([Object.values(requiredLabels)]);
  for (let row = 1; row <= templateRows; row += 1) list[XLSX.utils.encode_cell({ r: row, c: 0 })] = { t: 'z', z: '@' };
  list['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: templateRows, c: 2 } });
  list['!cols'] = [{ wch: 18 }, { wch: 36 }, { wch: 14 }];
  const notes = XLSX.utils.aoa_to_sheet([
    ['填写说明'],
    ['1. 每行一个战客集团，集团编码、集团名称、客户经理三列都必须填写，缺任何一项的行不会导入。'],
    ['2. 集团编码按文本填写，开头的 0 会保留；与台账中的集团编码一致才能匹配专线。'],
    ['3. 客户经理填写姓名，与台账中的客户经理姓名一致。'],
    ['4. 同一集团编码出现多次时只保留第一行。'],
    ['5. 每次导入都是一份完整的战客清单，会整份替换上一次导入的清单。'],
    ['6. 可以在三列之后增加其他列，系统只读取这三列。']
  ]);
  notes['!cols'] = [{ wch: 80 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, list, '战客清单');
  XLSX.utils.book_append_sheet(book, notes, '填写说明');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * 战客专线渗透. A strategic customer group is penetrated when it has a line in service (正常在用,
 * 停机执行中 or 停机), lost when it has none in service but has had one cancelled, and untouched
 * when it has never had either. Lines that never came into service (回退, 临时生成资料, blank)
 * do not count. The KPI switch limits the lines like everywhere else.
 */
export function createStrategicRouter({ db, leasedLineSource, currentUser, normalizeFileName = (name) => name, beforeReplace = async () => null }) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1, fields: 0 } });
  const previews = new Map();

  db.exec(`
  CREATE TABLE IF NOT EXISTS strategic_customer (
    group_code TEXT PRIMARY KEY,
    group_name TEXT,
    manager_name TEXT,
    import_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS strategic_import (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT,
    sheet_name TEXT,
    row_count INTEGER NOT NULL,
    added INTEGER NOT NULL,
    removed INTEGER NOT NULL,
    imported_by TEXT,
    imported_at TEXT NOT NULL
  );
  `);

  const inService = billableStatuses;
  const status = "COALESCE(l.product_status_name, l.ledger_status, '')";
  const monthlyFee = 'CASE WHEN COALESCE(l.actual_monthly_fee, 0) > 0 THEN l.actual_monthly_fee ELSE COALESCE(l.package_fee, 0) END';
  const marks = (values) => values.map(() => '?').join(', ');

  function lastImport() {
    return db.prepare('SELECT file_name, row_count, imported_by, imported_at FROM strategic_import ORDER BY id DESC LIMIT 1').get() ?? null;
  }

  function classify(row) {
    if (row.activeLines > 0) return 'penetrated';
    if (row.cancelledLines > 0) return 'lost';
    return 'untouched';
  }

  router.get('/', (req, res) => {
    const source = leasedLineSource(req.query);
    const groups = db.prepare(
      `WITH lines AS (
         SELECT l.group_code, l.group_name, ${status} AS status, ${monthlyFee} AS fee, l.start_time, l.status_time
         FROM ${source} l
         WHERE l.group_code IN (SELECT group_code FROM strategic_customer)
       ),
       totals AS (
         SELECT group_code,
                SUM(CASE WHEN status IN (${marks(inService)}) THEN 1 ELSE 0 END) AS activeLines,
                SUM(CASE WHEN status IN (${marks(cancelledStatuses)}) THEN 1 ELSE 0 END) AS cancelledLines,
                SUM(CASE WHEN status IN (${marks(inService)}) THEN fee ELSE 0 END) AS activeMonthlyFee,
                MAX(CASE WHEN status IN (${marks(cancelledStatuses)}) THEN status_time END) AS lastCancelledAt,
                MIN(CASE WHEN status IN (${marks(inService)}) THEN start_time END) AS firstStartAt,
                MAX(group_name) AS ledgerGroupName
         FROM lines GROUP BY group_code
       )
       SELECT s.group_code AS groupCode, COALESCE(NULLIF(s.group_name, ''), t.ledgerGroupName) AS groupName,
              NULLIF(s.manager_name, '') AS managerName,
              COALESCE(t.activeLines, 0) AS activeLines, COALESCE(t.cancelledLines, 0) AS cancelledLines,
              COALESCE(t.activeMonthlyFee, 0) AS activeMonthlyFee, t.lastCancelledAt, t.firstStartAt
       FROM strategic_customer s
       LEFT JOIN totals t ON t.group_code = s.group_code`
    ).all(...inService, ...cancelledStatuses, ...inService, ...cancelledStatuses, ...inService)
      .map((row) => ({ ...row, status: classify(row) }));

    const count = (key) => groups.filter((row) => row.status === key).length;
    const total = groups.length;
    res.json({
      list: lastImport(),
      summary: {
        total,
        penetrated: count('penetrated'),
        lost: count('lost'),
        untouched: count('untouched'),
        penetrationRate: total > 0 ? count('penetrated') / total : null,
        activeLines: groups.reduce((sum, row) => sum + row.activeLines, 0),
        activeMonthlyFee: groups.reduce((sum, row) => sum + row.activeMonthlyFee, 0)
      },
      groups
    });
  });

  router.get('/groups/:code', (req, res) => {
    const code = String(req.params.code);
    const customer = db.prepare('SELECT group_code, group_name, manager_name FROM strategic_customer WHERE group_code = ?').get(code);
    if (!customer) return res.status(404).json({ error: '这个集团不在战客清单中' });
    const lines = db.prepare(
      `SELECT l.id, l.group_product_code, l.group_user_name, l.product_name, ${status} AS status, l.bandwidth,
              l.manager_name, l.start_time, l.status_time, ${monthlyFee} AS monthly_fee,
              CASE WHEN ${status} IN (${marks(inService)}) THEN 'active' WHEN ${status} IN (${marks(cancelledStatuses)}) THEN 'cancelled' ELSE 'other' END AS kind
       FROM ${leasedLineSource(req.query)} l WHERE l.group_code = ?
       ORDER BY kind ASC, l.start_time DESC`
    ).all(...inService, ...cancelledStatuses, code);
    const activeLines = lines.filter((line) => line.kind === 'active').length;
    const cancelledLines = lines.filter((line) => line.kind === 'cancelled').length;
    res.json({
      group: {
        groupCode: customer.group_code,
        groupName: customer.group_name || lines.find((line) => line.group_user_name)?.group_user_name || null,
        managerName: customer.manager_name || null,
        status: classify({ activeLines, cancelledLines }),
        activeLines,
        cancelledLines,
        activeMonthlyFee: lines.filter((line) => line.kind === 'active').reduce((sum, line) => sum + line.monthly_fee, 0)
      },
      lines
    });
  });

  router.get('/template', (req, res) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="strategic-customer-template.xlsx"; filename*=UTF-8''${encodeURIComponent('战客清单导入模板.xlsx')}`);
    res.send(strategicTemplate());
  });

  // Reading the file changes nothing: the result waits for a confirmation, briefly.
  router.post('/preview', (req, res) => {
    upload.single('file')(req, res, (error) => {
      if (error) {
        const tooLarge = error.code === 'LIMIT_FILE_SIZE';
        return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? `文件不能超过 ${maxUploadMb} MB` : `文件上传失败：${error.message}` });
      }
      if (!req.file) return res.status(400).json({ error: '请选择战客清单 Excel 文件' });
      let parsed;
      try {
        parsed = parseStrategicWorkbook(req.file.buffer);
      } catch (parseError) {
        return res.status(400).json({ error: parseError.message });
      }
      if (parsed.rows.length === 0) {
        return res.status(400).json({ error: parsed.incomplete > 0 ? `清单里没有三列都填写完整的行（${parsed.incomplete} 行有缺项）` : '清单里没有战客集团' });
      }
      const now = Date.now();
      for (const [key, item] of previews) if (item.expiresAt < now) previews.delete(key);
      const current = new Set(db.prepare('SELECT group_code FROM strategic_customer').all().map((row) => row.group_code));
      const incoming = new Set(parsed.rows.map((row) => row.group_code));
      const ledgerCodes = new Set(db.prepare("SELECT DISTINCT group_code FROM leased_line WHERE COALESCE(group_code, '') <> ''").all().map((row) => row.group_code));
      const token = crypto.randomUUID();
      previews.set(token, { parsed, fileName: normalizeFileName(req.file.originalname), expiresAt: now + previewMinutes * 60 * 1000 });
      res.json({
        token,
        fileName: normalizeFileName(req.file.originalname),
        sheetName: parsed.sheetName,
        columns: parsed.columns,
        rowCount: parsed.rows.length,
        incomplete: parsed.incomplete,
        incompleteRows: parsed.incompleteRows,
        duplicates: parsed.duplicates,
        inLedger: parsed.rows.filter((row) => ledgerCodes.has(row.group_code)).length,
        added: [...incoming].filter((code) => !current.has(code)).length,
        removed: [...current].filter((code) => !incoming.has(code)).length,
        replacing: current.size > 0
      });
    });
  });

  // The list is replaced as a whole: a group missing from the new file is no longer a strategic customer.
  router.post('/commit', async (req, res) => {
    const preview = previews.get(String(req.body?.token || ''));
    if (!preview || preview.expiresAt < Date.now()) return res.status(409).json({ error: '预览已过期，请重新选择文件' });
    previews.delete(String(req.body.token));
    // A failed backup is reported but does not hold the replacement up.
    let backup = null;
    let backupError = '';
    try {
      backup = await beforeReplace(req, preview.fileName);
    } catch (error) {
      backupError = error.message;
    }
    const current = new Set(db.prepare('SELECT group_code FROM strategic_customer').all().map((row) => row.group_code));
    const incoming = new Set(preview.parsed.rows.map((row) => row.group_code));
    db.exec('BEGIN');
    try {
      const result = db.prepare(
        'INSERT INTO strategic_import (file_name, sheet_name, row_count, added, removed, imported_by, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(preview.fileName, preview.parsed.sheetName, preview.parsed.rows.length,
        [...incoming].filter((code) => !current.has(code)).length,
        [...current].filter((code) => !incoming.has(code)).length,
        currentUser(req)?.username || '', new Date().toISOString());
      db.exec('DELETE FROM strategic_customer');
      const insert = db.prepare('INSERT INTO strategic_customer (group_code, group_name, manager_name, import_id) VALUES (?, ?, ?, ?)');
      for (const row of preview.parsed.rows) insert.run(row.group_code, row.group_name, row.manager_name, Number(result.lastInsertRowid));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json({ rowCount: preview.parsed.rows.length, list: lastImport(), backup: backup?.name ?? null, backupError });
  });

  return router;
}
