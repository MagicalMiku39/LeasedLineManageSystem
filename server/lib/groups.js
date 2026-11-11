import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import XLSX from './xlsx.js';
import { billableStatuses, cancelledStatuses } from './ledger-rules.js';
import { stoppedDays, warningLevel } from './warnings.js';

const maxUploadMb = 32;
const previewMinutes = 15;
const headerSearchRows = 10;
const shownIncompleteRows = 20;
const pageSizes = [50, 100, 200];
export const strategicSegment = '战客';

// Column names the full group list may use; the first one found wins.
const columnAliases = {
  group_code: ['集团编码', '集团编号', '集团ID', '集团代码'],
  group_name: ['集团名称', '集团客户名称'],
  manager_name: ['集团客户经理名称', '客户经理名称', '客户经理姓名', '客户经理'],
  manager_id: ['集团客户经理标识', '客户经理工号', '客户经理标识'],
  group_level: ['集团级别'],
  micro_grid: ['微网格名称', '微网格'],
  joined_at: ['入网时间'],
  member_count: ['成员到达数'],
  employee_count: ['企业员工数'],
  mobile_member_count: ['移动成员数'],
  member_billing: ['成员出账金额'],
  segment: ['商客战客集团标识', '商客战客标识'],
  data_month: ['数据月份']
};
const requiredLabels = { group_code: '集团编码', group_name: '集团名称', manager_name: '集团客户经理名称' };
const keyCategoryColumns = ['客户类别'];
const numericFields = ['member_count', 'employee_count', 'mobile_member_count', 'member_billing'];

const clean = (value) => String(value ?? '').replace(/\s+/g, '').trim();
const text = (value) => String(value ?? '').trim();
const marks = (values) => values.map(() => '?').join(', ');

function numberOrNull(value) {
  const raw = clean(value).replaceAll(',', '');
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function sheetCells(sheet) {
  if (!sheet?.['!ref']) return null;
  const cells = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true });
  const firstRow = XLSX.utils.decode_range(sheet['!ref']).s.r;
  return { cells, firstRow };
}

/**
 * Reads the full group list. The workbook may carry several sheets:
 * - the list itself: the sheet with 集团编码, 集团名称 and the manager's name (the one named
 *   全量… when several qualify, otherwise the longest);
 * - any sheet with a 客户类别 column beside the group code: a key-customer list, whose category
 *   (要客, 139要客) is attached to the groups it names.
 * Every other sheet is ignored. Codes are text, so leading zeros stay; duplicates keep the first row.
 */
export function parseGroupWorkbook(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch {
    throw new Error('无法读取 Excel 文件，请检查文件是否损坏或加密');
  }
  const candidates = [];
  const keySheets = [];
  let partial = null;
  for (const sheetName of workbook.SheetNames) {
    const read = sheetCells(workbook.Sheets[sheetName]);
    if (!read) continue;
    const headerIndex = read.cells.slice(0, headerSearchRows).findIndex((row) => row.some((cell) => columnAliases.group_code.includes(clean(cell))));
    if (headerIndex < 0) continue;
    const headers = read.cells[headerIndex].map(clean);
    const position = Object.fromEntries(Object.entries(columnAliases).map(([field, aliases]) => [field, headers.findIndex((name) => aliases.includes(name))]));
    const categoryIndex = headers.findIndex((name) => keyCategoryColumns.includes(name));
    if (categoryIndex >= 0) {
      keySheets.push({ sheetName, ...read, headerIndex, codeIndex: position.group_code, categoryIndex });
      continue;
    }
    const absent = Object.keys(requiredLabels).filter((field) => position[field] < 0);
    if (absent.length) {
      partial ??= absent;
      continue;
    }
    candidates.push({ sheetName, ...read, headerIndex, headers, position });
  }
  if (!candidates.length) {
    if (partial) throw new Error(`全量集团清单缺少${partial.map((field) => `“${requiredLabels[field]}”`).join('、')}列`);
    throw new Error('没有找到同时含“集团编码”“集团名称”“集团客户经理名称”三列的工作表');
  }
  const main = candidates.find((item) => item.sheetName.includes('全量'))
    || candidates.reduce((best, item) => (item.cells.length > best.cells.length ? item : best));

  const rows = [];
  const seen = new Set();
  const incompleteRows = [];
  let incomplete = 0;
  let duplicates = 0;
  main.cells.slice(main.headerIndex + 1).forEach((row, index) => {
    if (!row.some((cell) => clean(cell))) return;
    const at = (field) => (main.position[field] >= 0 ? row[main.position[field]] : '');
    const values = {
      group_code: clean(at('group_code')),
      group_name: text(at('group_name')),
      manager_name: clean(at('manager_name')),
      manager_id: clean(at('manager_id')),
      group_level: clean(at('group_level')),
      micro_grid: text(at('micro_grid')),
      joined_at: text(at('joined_at')),
      segment: clean(at('segment')),
      data_month: clean(at('data_month')),
      key_category: ''
    };
    for (const field of numericFields) values[field] = numberOrNull(at(field));
    const missing = Object.keys(requiredLabels).filter((field) => !values[field]).map((field) => requiredLabels[field]);
    if (missing.length) {
      incomplete += 1;
      if (incompleteRows.length < shownIncompleteRows) incompleteRows.push({ row: main.firstRow + main.headerIndex + index + 2, missing });
      return;
    }
    if (seen.has(values.group_code)) {
      duplicates += 1;
      return;
    }
    seen.add(values.group_code);
    rows.push(values);
  });

  // Key-customer categories, by group code; a group named on several sheets keeps the first.
  const categories = new Map();
  for (const sheet of keySheets) {
    for (const row of sheet.cells.slice(sheet.headerIndex + 1)) {
      const code = clean(row[sheet.codeIndex]);
      const category = clean(row[sheet.categoryIndex]);
      if (code && category && !categories.has(code)) categories.set(code, category);
    }
  }
  let keyMatched = 0;
  for (const row of rows) {
    const category = categories.get(row.group_code);
    if (category) {
      row.key_category = category;
      keyMatched += 1;
    }
  }
  const months = [...new Set(rows.map((row) => row.data_month).filter(Boolean))].sort();
  return {
    sheetName: main.sheetName,
    rows,
    incomplete,
    incompleteRows,
    duplicates,
    dataMonth: months.at(-1) || '',
    keySheets: keySheets.map((sheet) => sheet.sheetName),
    keyRows: categories.size,
    keyMatched,
    keyUnmatched: categories.size - keyMatched,
    ignoredSheets: workbook.SheetNames.filter((name) => name !== main.sheetName && !keySheets.some((sheet) => sheet.sheetName === name))
  };
}

/** The group directory's tables; the strategic page reads them too, so either may run first. */
export function ensureGroupDirectory(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS group_directory (
    group_code TEXT PRIMARY KEY,
    group_name TEXT,
    manager_name TEXT,
    manager_id TEXT,
    group_level TEXT,
    micro_grid TEXT,
    joined_at TEXT,
    member_count REAL,
    employee_count REAL,
    mobile_member_count REAL,
    member_billing REAL,
    segment TEXT,
    key_category TEXT,
    data_month TEXT,
    import_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS group_directory_import (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT,
    sheet_name TEXT,
    row_count INTEGER NOT NULL,
    added INTEGER NOT NULL,
    removed INTEGER NOT NULL,
    manager_changed INTEGER NOT NULL,
    key_rows INTEGER NOT NULL,
    data_month TEXT,
    imported_by TEXT,
    imported_at TEXT NOT NULL
  );
  `);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'leased_line'").get()) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_leased_line_group ON leased_line(group_code)');
  }
}

// The manager the ledger has for a group: with several, the one on most lines.
export const ledgerManagerSql = (codeExpression) => `(SELECT lm.manager_name FROM leased_line lm
  WHERE lm.group_code = ${codeExpression} AND COALESCE(lm.manager_name, '') <> ''
  GROUP BY lm.manager_name ORDER BY COUNT(*) DESC, lm.manager_name ASC LIMIT 1)`;

/**
 * Where the strategic customer groups come from: the strategic list once one has been imported,
 * and until then the groups the full list marks as 战客 (with the ledger's manager where the
 * ledger has one). Returns a table expression with group_code, group_name and manager_name.
 */
export function strategicCustomerSource(db) {
  ensureGroupDirectory(db);
  const imported = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'strategic_customer'").get()
    && db.prepare('SELECT 1 FROM strategic_customer LIMIT 1').get();
  if (imported) return { from: 'strategic', sql: 'strategic_customer' };
  return {
    from: 'directory',
    sql: `(SELECT d.group_code, d.group_name, COALESCE(${ledgerManagerSql('d.group_code')}, d.manager_name) AS manager_name
           FROM group_directory d WHERE d.segment = '${strategicSegment}')`
  };
}

/**
 * 集团: every group on the full list together with every group the ledger has lines for. The
 * full list is replaced as a whole on each import. Where the list and the ledger name different
 * managers the ledger wins, and the difference is reported; a group with no lines keeps the
 * list's manager. Line counts follow the KPI switch like everywhere else.
 */
export function createGroupsRouter({ db, leasedLineSource, currentUser, normalizeFileName = (name) => name, beforeReplace = async () => null }) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1, fields: 0 } });
  const previews = new Map();
  ensureGroupDirectory(db);

  const status = "COALESCE(l.product_status_name, l.ledger_status, '')";
  const monthlyFee = 'CASE WHEN COALESCE(l.actual_monthly_fee, 0) > 0 THEN l.actual_monthly_fee ELSE COALESCE(l.package_fee, 0) END';
  const statusParams = [...billableStatuses, ...cancelledStatuses];

  function lastImport() {
    return db.prepare('SELECT file_name, sheet_name, row_count, key_rows, data_month, imported_by, imported_at FROM group_directory_import ORDER BY id DESC LIMIT 1').get() ?? null;
  }

  // One row per group; takes the in-service and cancelled statuses as its parameters.
  function unified(source) {
    const strategic = strategicCustomerSource(db);
    const strategicTest = strategic.from === 'strategic'
      ? 'c.code IN (SELECT group_code FROM strategic_customer)'
      : `d.segment = '${strategicSegment}'`;
    return `WITH line_totals AS (
        SELECT l.group_code AS code, COUNT(*) AS totalLines,
               SUM(CASE WHEN ${status} IN (${marks(billableStatuses)}) THEN 1 ELSE 0 END) AS activeLines,
               SUM(CASE WHEN ${status} IN (${marks(cancelledStatuses)}) THEN 1 ELSE 0 END) AS cancelledLines
        FROM ${source} l WHERE COALESCE(l.group_code, '') <> '' GROUP BY l.group_code
      ),
      ledger_groups AS (
        SELECT group_code AS code, MAX(group_name) AS name FROM leased_line WHERE COALESCE(group_code, '') <> '' GROUP BY group_code
      ),
      manager_rank AS (
        SELECT group_code AS code, manager_name AS name,
               ROW_NUMBER() OVER (PARTITION BY group_code ORDER BY COUNT(*) DESC, manager_name ASC) AS position
        FROM leased_line WHERE COALESCE(group_code, '') <> '' AND COALESCE(manager_name, '') <> ''
        GROUP BY group_code, manager_name
      ),
      codes AS (SELECT group_code AS code FROM group_directory UNION SELECT code FROM ledger_groups),
      unified AS (
        SELECT c.code AS groupCode,
               COALESCE(NULLIF(g.name, ''), NULLIF(d.group_name, ''), '') AS groupName,
               COALESCE(m.name, NULLIF(d.manager_name, ''), '') AS managerName,
               m.name AS ledgerManager, NULLIF(d.manager_name, '') AS directoryManager,
               CASE WHEN m.name IS NOT NULL AND COALESCE(d.manager_name, '') <> '' AND m.name <> d.manager_name THEN 1 ELSE 0 END AS managerMismatch,
               NULLIF(d.group_level, '') AS level, NULLIF(d.segment, '') AS segment, NULLIF(d.key_category, '') AS keyCategory,
               CASE WHEN d.group_code IS NULL THEN 0 ELSE 1 END AS listed,
               CASE WHEN g.code IS NULL THEN 0 ELSE 1 END AS inLedger,
               CASE WHEN ${strategicTest} THEN 1 ELSE 0 END AS strategic,
               COALESCE(t.totalLines, 0) AS totalLines, COALESCE(t.activeLines, 0) AS activeLines, COALESCE(t.cancelledLines, 0) AS cancelledLines
        FROM codes c
        LEFT JOIN group_directory d ON d.group_code = c.code
        LEFT JOIN ledger_groups g ON g.code = c.code
        LEFT JOIN line_totals t ON t.code = c.code
        LEFT JOIN manager_rank m ON m.code = c.code AND m.position = 1
      )`;
  }

  const view = (row) => ({ ...row, managerMismatch: Boolean(row.managerMismatch), listed: Boolean(row.listed), inLedger: Boolean(row.inLedger), strategic: Boolean(row.strategic) });

  // The WHERE clause a list or an export narrows the groups by.
  function filters(query) {
    const where = [];
    const params = [];
    const keyword = text(query.search);
    if (keyword) {
      const like = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;
      where.push("(groupCode LIKE ? ESCAPE '\\' OR groupName LIKE ? ESCAPE '\\' OR managerName LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    const lines = { active: 'activeLines > 0', inactive: 'activeLines = 0 AND inLedger = 1', none: 'inLedger = 0' }[query.lines];
    if (lines) where.push(lines);
    const mark = {
      strategic: 'strategic = 1',
      key: 'keyCategory IS NOT NULL',
      mismatch: 'managerMismatch = 1',
      unlisted: 'listed = 0'
    }[query.mark];
    if (mark) where.push(mark);
    if (['A', 'B', 'C', 'D'].includes(query.level)) {
      where.push('level = ?');
      params.push(query.level);
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  const order = 'ORDER BY activeLines DESC, totalLines DESC, listed DESC, groupCode ASC';

  router.get('/', (req, res) => {
    const source = leasedLineSource(req.query);
    const cte = unified(source);
    const narrowed = filters(req.query);
    const pageSize = pageSizes.includes(Number(req.query.pageSize)) ? Number(req.query.pageSize) : pageSizes[0];
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const total = db.prepare(`${cte} SELECT COUNT(*) AS count FROM unified ${narrowed.sql}`).get(...statusParams, ...narrowed.params).count;
    const rows = db.prepare(`${cte} SELECT * FROM unified ${narrowed.sql} ${order} LIMIT ? OFFSET ?`)
      .all(...statusParams, ...narrowed.params, pageSize, (page - 1) * pageSize).map(view);
    const summary = db.prepare(`${cte} SELECT COUNT(*) AS total, COALESCE(SUM(listed), 0) AS listed,
        COALESCE(SUM(CASE WHEN activeLines > 0 THEN 1 ELSE 0 END), 0) AS withActive,
        COALESCE(SUM(CASE WHEN activeLines = 0 AND inLedger = 1 THEN 1 ELSE 0 END), 0) AS inactive,
        COALESCE(SUM(CASE WHEN inLedger = 0 THEN 1 ELSE 0 END), 0) AS noLines,
        COALESCE(SUM(CASE WHEN listed = 0 THEN 1 ELSE 0 END), 0) AS unlisted,
        COALESCE(SUM(managerMismatch), 0) AS mismatch,
        COALESCE(SUM(strategic), 0) AS strategic,
        COALESCE(SUM(CASE WHEN keyCategory IS NOT NULL THEN 1 ELSE 0 END), 0) AS keyCustomers
      FROM unified`).get(...statusParams);
    res.json({ list: lastImport(), strategicFrom: strategicCustomerSource(db).from, summary, total, page, pageSize, rows });
  });

  router.get('/export', (req, res) => {
    const narrowed = filters(req.query);
    const rows = db.prepare(`${unified(leasedLineSource(req.query))} SELECT * FROM unified ${narrowed.sql} ${order}`)
      .all(...statusParams, ...narrowed.params).map(view);
    const sheet = XLSX.utils.json_to_sheet(rows.map((row) => ({
      集团编码: row.groupCode,
      集团名称: row.groupName,
      客户经理: row.managerName,
      清单客户经理: row.directoryManager ?? '',
      台账客户经理: row.ledgerManager ?? '',
      客户经理是否一致: row.managerMismatch ? '不一致' : '',
      集团级别: row.level ?? '',
      商客战客: row.segment ?? '',
      是否战客: row.strategic ? '是' : '否',
      客户类别: row.keyCategory ?? '',
      在用专线: row.activeLines,
      已销户专线: row.cancelledLines,
      台账专线合计: row.totalLines,
      在全量清单中: row.listed ? '是' : '否'
    })));
    for (let index = 1; index <= rows.length; index += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: index, c: 0 })];
      if (cell) { cell.t = 's'; cell.z = '@'; }
    }
    sheet['!cols'] = [{ wch: 14 }, { wch: 40 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 12 }];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '集团');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="groups.xlsx"; filename*=UTF-8''${encodeURIComponent('集团清单.xlsx')}`);
    res.send(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  });

  // Reading the file changes nothing: the result waits for a confirmation, briefly.
  router.post('/preview', (req, res) => {
    upload.single('file')(req, res, (error) => {
      if (error) {
        const tooLarge = error.code === 'LIMIT_FILE_SIZE';
        return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? `文件不能超过 ${maxUploadMb} MB` : `文件上传失败：${error.message}` });
      }
      if (!req.file) return res.status(400).json({ error: '请选择全量集团清单 Excel 文件' });
      let parsed;
      try {
        parsed = parseGroupWorkbook(req.file.buffer);
      } catch (parseError) {
        return res.status(400).json({ error: parseError.message });
      }
      if (parsed.rows.length === 0) {
        return res.status(400).json({ error: parsed.incomplete > 0 ? `清单里没有集团编码、集团名称、客户经理都填写完整的行（${parsed.incomplete} 行有缺项）` : '清单里没有集团' });
      }
      const now = Date.now();
      for (const [key, item] of previews) if (item.expiresAt < now) previews.delete(key);
      const fileName = normalizeFileName(req.file.originalname);
      const token = crypto.randomUUID();
      previews.set(token, { parsed, fileName, expiresAt: now + previewMinutes * 60 * 1000 });
      const { rows, incompleteRows, ...facts } = parsed;
      res.json({ token, fileName, ...facts, incompleteRows, rowCount: rows.length, ...compare(rows) });
    });
  });

  // What replacing the list with these rows changes, and how the rows sit against the ledger.
  function compare(rows) {
    const current = new Map(db.prepare('SELECT group_code, manager_name FROM group_directory').all().map((row) => [row.group_code, row.manager_name]));
    const incoming = new Set(rows.map((row) => row.group_code));
    const ledger = new Map(db.prepare(`SELECT g.code, ${ledgerManagerSql('g.code')} AS manager
      FROM (SELECT DISTINCT group_code AS code FROM leased_line WHERE COALESCE(group_code, '') <> '') g`).all().map((row) => [row.code, row.manager]));
    let added = 0;
    let managerChanged = 0;
    let inLedger = 0;
    let ledgerMismatch = 0;
    for (const row of rows) {
      if (!current.has(row.group_code)) added += 1;
      else if (current.get(row.group_code) !== row.manager_name) managerChanged += 1;
      if (ledger.has(row.group_code)) {
        inLedger += 1;
        const manager = ledger.get(row.group_code);
        if (manager && manager !== row.manager_name) ledgerMismatch += 1;
      }
    }
    return {
      added,
      removed: [...current.keys()].filter((code) => !incoming.has(code)).length,
      managerChanged,
      replacing: current.size > 0,
      inLedger,
      ledgerMismatch,
      ledgerUnlisted: [...ledger.keys()].filter((code) => !incoming.has(code)).length,
      strategic: rows.filter((row) => row.segment === strategicSegment).length
    };
  }

  // The list is replaced as a whole: a group missing from the new file leaves the list.
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
    const { parsed } = preview;
    const changes = compare(parsed.rows);
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare(
        `INSERT INTO group_directory_import (file_name, sheet_name, row_count, added, removed, manager_changed, key_rows, data_month, imported_by, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(preview.fileName, parsed.sheetName, parsed.rows.length, changes.added, changes.removed, changes.managerChanged,
        parsed.keyMatched, parsed.dataMonth, currentUser(req)?.username || '', new Date().toISOString());
      const importId = Number(result.lastInsertRowid);
      db.exec('DELETE FROM group_directory');
      const insert = db.prepare(
        `INSERT INTO group_directory (group_code, group_name, manager_name, manager_id, group_level, micro_grid, joined_at,
           member_count, employee_count, mobile_member_count, member_billing, segment, key_category, data_month, import_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const row of parsed.rows) {
        insert.run(row.group_code, row.group_name, row.manager_name, row.manager_id, row.group_level, row.micro_grid, row.joined_at,
          row.member_count, row.employee_count, row.mobile_member_count, row.member_billing, row.segment, row.key_category, row.data_month, importId);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json({ rowCount: parsed.rows.length, ...changes, list: lastImport(), backup: backup?.name ?? null, backupError });
  });

  /** One group on one page: who it is, its lines, what is at risk, and what has been happening. */
  router.get('/:code', (req, res) => {
    const code = String(req.params.code);
    const source = leasedLineSource(req.query);
    const row = db.prepare(`${unified(source)} SELECT * FROM unified WHERE groupCode = ?`).get(...statusParams, code);
    if (!row) return res.status(404).json({ error: '没有这个集团：它既不在全量集团清单中，台账里也没有它的专线' });
    const listed = db.prepare('SELECT * FROM group_directory WHERE group_code = ?').get(code) ?? null;
    const lines = db.prepare(
      `SELECT l.id, l.group_product_code, l.product_code, l.group_user_name, l.product_name, ${status} AS status, l.bandwidth,
              l.manager_name, l.start_time, l.status_time, ${monthlyFee} AS monthly_fee, COALESCE(l.total_arrears, 0) AS total_arrears,
              CASE WHEN ${status} IN (${marks(billableStatuses)}) THEN 'active' WHEN ${status} IN (${marks(cancelledStatuses)}) THEN 'cancelled' ELSE 'other' END AS kind
       FROM ${source} l WHERE l.group_code = ?
       ORDER BY kind ASC, l.start_time DESC, l.id DESC`
    ).all(...statusParams, code);
    const tally = (key) => {
      const counts = new Map();
      for (const line of lines) counts.set(line[key] || '未填写', (counts.get(line[key] || '未填写') || 0) + 1);
      return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
    };
    const active = lines.filter((line) => line.kind === 'active');
    const asOf = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const warnings = lines
      .filter((line) => line.status === '停机' && line.total_arrears > 0)
      .flatMap((line) => {
        const days = stoppedDays(line.status_time, asOf);
        return days === null ? [] : [{ id: line.id, group_product_code: line.group_product_code, product_name: line.product_name, status_time: line.status_time,
          total_arrears: line.total_arrears, stopped_days: days, warning_level: warningLevel(days) }];
      })
      .sort((a, b) => b.stopped_days - a.stopped_days || b.total_arrears - a.total_arrears);
    const changes = db.prepare(
      `SELECT c.id, c.line_id, c.group_product_code, c.change_type, c.field_name, c.old_value, c.new_value, c.note, c.created_at
       FROM ledger_change c JOIN leased_line l ON l.id = c.line_id
       WHERE l.group_code = ? ORDER BY c.id DESC LIMIT 30`
    ).all(code);
    const forecasts = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kpi_forecast'").get()
      ? db.prepare(
        `SELECT f.id, f.year, f.month, f.kind, f.product_type, f.line_count, f.landed_count, f.confidence,
                (SELECT note FROM kpi_forecast_progress p WHERE p.forecast_id = f.id ORDER BY p.id DESC LIMIT 1) AS latest_note,
                (SELECT created_at FROM kpi_forecast_progress p WHERE p.forecast_id = f.id ORDER BY p.id DESC LIMIT 1) AS latest_at
         FROM kpi_forecast f WHERE f.group_code = ? ORDER BY f.year DESC, f.month DESC, f.id DESC LIMIT 30`
      ).all(code)
      : [];
    const group = view(row);
    res.json({
      group: {
        ...group,
        strategicStatus: group.strategic ? (group.activeLines > 0 ? 'penetrated' : group.cancelledLines > 0 ? 'lost' : 'untouched') : null,
        activeMonthlyFee: active.reduce((sum, line) => sum + line.monthly_fee, 0),
        totalArrears: lines.reduce((sum, line) => sum + line.total_arrears, 0),
        dataMonth: listed?.data_month || null,
        more: listed && {
          microGrid: listed.micro_grid || null,
          joinedAt: listed.joined_at || null,
          memberCount: listed.member_count,
          employeeCount: listed.employee_count,
          mobileMemberCount: listed.mobile_member_count,
          memberBilling: listed.member_billing
        }
      },
      strategicFrom: strategicCustomerSource(db).from,
      statuses: tally('status'),
      products: (() => {
        const counts = new Map();
        for (const line of active) counts.set(line.product_name || '未填写', (counts.get(line.product_name || '未填写') || 0) + 1);
        return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
      })(),
      lines,
      warnings,
      warningsAsOf: asOf,
      changes,
      forecasts
    });
  });

  return router;
}
