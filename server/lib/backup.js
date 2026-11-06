import crypto from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { Router } from 'express';
import { requestSource } from './client-cert.js';

const day = 24 * 60 * 60 * 1000;
const weeklyCheckMs = 60 * 60 * 1000;
const weeklyFirstCheckMs = 2 * 60 * 1000;
const namePattern = /^ledger-\d{8}T\d{6}Z-[a-z-]+-[0-9a-f]{6}\.db\.gz$/;

// Why a backup was made, and how many of each kind are kept; the oldest go first.
export const backupReasons = {
  'ledger-import': { label: '导入到达日清单前', keep: 30 },
  'strategic-import': { label: '替换战客清单前', keep: 10 },
  weekly: { label: '每周自动', keep: 12 },
  manual: { label: '手动', keep: 10 },
  'before-restore': { label: '回退前', keep: 10 }
};

/**
 * What a rollback brings back, in the order rows go in (parents before the rows that point at
 * them). 台账类数据 takes the KPI forecasts along, because confirming a line as landed changes
 * the forecast and its progress, and the warning marks, which belong to lines. Accounts, the
 * security log, revenue, KPI targets and sent mail are never rolled back.
 */
export const restoreScopes = {
  ledger: {
    label: '台账类数据',
    tables: [
      ['leased_line', '台账专线'],
      ['import_batch', '导入批次'],
      ['import_row_log', '导入行记录'],
      ['ledger_change', '变更记录'],
      ['ledger_import_summary', '导入净增记录'],
      ['change_log', '手工修改记录'],
      ['line_warning_mark', '预警标记'],
      ['kpi_forecast', 'KPI 预计任务'],
      ['kpi_forecast_match', 'KPI 落地确认'],
      ['kpi_forecast_progress', 'KPI 进展记录']
    ]
  },
  strategic: {
    label: '战客清单',
    tables: [
      ['strategic_import', '战客清单导入记录'],
      ['strategic_customer', '战客集团']
    ]
  }
};

export class BackupError extends Error {}

function freeBytes(dir) {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

// Recent writes sit in the WAL file until a checkpoint, so it counts too.
function databaseBytes(path) {
  return [path, `${path}-wal`].reduce((sum, file) => sum + (existsSync(file) ? statSync(file).size : 0), 0);
}

function count(file, table) {
  const snapshot = new DatabaseSync(file, { readOnly: true });
  try {
    return snapshot.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  } catch {
    return null;
  } finally {
    snapshot.close();
  }
}

/**
 * Snapshots of the whole database, made with VACUUM INTO so they are consistent while the
 * service runs, then gzipped. Each file has a small .json beside it, so the list survives even if
 * the database itself is lost. Only the newest few of each kind are kept.
 */
export function createBackupService({ db, dbPath, dir = process.env.BACKUP_DIR || join(dirname(dbPath), 'backups'), now = () => new Date() }) {
  let queue = Promise.resolve();

  function list() {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => namePattern.test(name) && existsSync(join(dir, `${name}.json`)))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function prune(reason) {
    for (const item of list().filter((entry) => entry.reason === reason).slice(backupReasons[reason].keep)) {
      rmSync(join(dir, item.name), { force: true });
      rmSync(join(dir, `${item.name}.json`), { force: true });
    }
  }

  async function make(reason, { detail = '', createdBy = '' }) {
    if (!backupReasons[reason]) throw new BackupError(`未知的备份原因：${reason}`);
    mkdirSync(dir, { recursive: true });
    const databaseSize = databaseBytes(dbPath);
    const free = freeBytes(dir);
    // The uncompressed copy is written first, so the space for it has to be there.
    if (free !== null && free < databaseSize * 1.5) {
      throw new BackupError(`备份目录剩余空间不足（剩余 ${Math.round(free / 1048576)} MB，需要约 ${Math.round(databaseSize * 1.5 / 1048576)} MB）`);
    }
    const at = now();
    const name = `ledger-${at.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z-${reason}-${crypto.randomBytes(3).toString('hex')}.db.gz`;
    const raw = join(dir, `.${name}.db`);
    const part = join(dir, `.${name}.part`);
    try {
      db.exec(`VACUUM INTO '${raw.replaceAll("'", "''")}'`);
      const counts = { leasedLines: count(raw, 'leased_line'), importBatches: count(raw, 'import_batch'), strategicCustomers: count(raw, 'strategic_customer') };
      await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(part));
      renameSync(part, join(dir, name));
      const meta = {
        name,
        reason,
        detail: String(detail).slice(0, 200),
        createdBy,
        createdAt: at.toISOString(),
        size: statSync(join(dir, name)).size,
        databaseSize,
        counts
      };
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(meta, null, 2));
      prune(reason);
      return meta;
    } catch (error) {
      rmSync(join(dir, name), { force: true });
      if (error instanceof BackupError) throw error;
      throw new BackupError(`备份失败：${error.message}`);
    } finally {
      rmSync(raw, { force: true });
      rmSync(part, { force: true });
    }
  }

  // One backup at a time: two imports in a row each get their own, in order.
  function create(reason, options = {}) {
    const run = queue.then(() => make(reason, options));
    queue = run.catch(() => {});
    return run;
  }

  function lastWeekly() {
    return list().find((item) => item.reason === 'weekly') ?? null;
  }

  // Due when the last weekly backup is a week old, so a stopped service catches up on start.
  function weeklyDue() {
    const last = lastWeekly();
    return !last || now() - new Date(last.createdAt) >= 7 * day;
  }

  function startWeekly(log = console) {
    const check = () => {
      if (!weeklyDue()) return;
      create('weekly', { detail: lastWeekly() ? '距上次每周备份已满 7 天' : '首次每周备份' })
        .then((meta) => log.log(`Weekly backup written: ${meta.name}`))
        .catch((error) => log.error(`Weekly backup failed: ${error.message}`));
    };
    setTimeout(check, weeklyFirstCheckMs).unref();
    setInterval(check, weeklyCheckMs).unref();
  }

  function file(name) {
    if (!namePattern.test(String(name))) return null;
    const path = join(dir, name);
    return existsSync(path) && existsSync(`${path}.json`) ? path : null;
  }

  function scopeOf(key) {
    const scope = restoreScopes[key];
    if (!scope) throw new BackupError('请选择回退台账类数据还是战客清单');
    return scope;
  }

  // Unpacks a backup next to the others and attaches it as "snap" for the duration of work().
  async function withSnapshot(name, work) {
    const path = file(name);
    if (!path) throw new BackupError('找不到这个备份，可能已按保留规则清理');
    const raw = join(dir, `.restore-${crypto.randomBytes(4).toString('hex')}.db`);
    try {
      await pipeline(createReadStream(path), createGunzip(), createWriteStream(raw));
      db.exec(`ATTACH DATABASE '${raw.replaceAll("'", "''")}' AS snap`);
      try {
        if (!db.prepare("SELECT 1 FROM snap.sqlite_master WHERE type = 'table' AND name = 'leased_line'").get()) {
          throw new BackupError('这个文件不是本系统的备份');
        }
        return work();
      } finally {
        db.exec('DETACH DATABASE snap');
      }
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError(`读取备份失败：${error.message}`);
    } finally {
      rmSync(raw, { force: true });
    }
  }

  const inSnapshot = (table) => Boolean(db.prepare("SELECT 1 FROM snap.sqlite_master WHERE type = 'table' AND name = ?").get(table));
  const rows = (schema, table) => (schema === 'snap' && !inSnapshot(table) ? 0 : db.prepare(`SELECT COUNT(*) AS count FROM ${schema}.${table}`).get().count);
  const keys = (schema, table, column) => (schema === 'snap' && !inSnapshot(table)
    ? new Set()
    : new Set(db.prepare(`SELECT ${column} AS key FROM ${schema}.${table}`).all().map((row) => row.key)));

  // What a rollback would undo, worked out from the two databases side by side.
  function describe(scopeKey) {
    const scope = scopeOf(scopeKey);
    const tables = scope.tables.map(([table, label]) => ({ table, label, current: rows('main', table), backup: rows('snap', table) }));
    if (scopeKey === 'strategic') {
      const kept = keys('snap', 'strategic_import', 'id');
      const undone = db.prepare('SELECT id, file_name, imported_at FROM strategic_import ORDER BY id DESC').all().filter((row) => !kept.has(row.id));
      return { tables, imports: undone.map((row) => ({ fileName: row.file_name, importedAt: row.imported_at })) };
    }
    const keptBatches = keys('snap', 'import_batch', 'id');
    const undone = db.prepare("SELECT id, file_name, imported_at FROM import_batch WHERE status = 'finished' ORDER BY imported_at DESC").all().filter((row) => !keptBatches.has(row.id));
    const backupLines = new Map(db.prepare('SELECT id, updated_at FROM snap.leased_line').all().map((row) => [row.id, row.updated_at]));
    const currentLines = db.prepare('SELECT id, updated_at FROM main.leased_line').all();
    const currentLineIds = new Set(currentLines.map((row) => row.id));
    const keptEdits = keys('snap', 'change_log', 'id');
    const backupForecasts = inSnapshot('kpi_forecast')
      ? new Map(db.prepare('SELECT id, updated_at FROM snap.kpi_forecast').all().map((row) => [row.id, row.updated_at]))
      : new Map();
    const currentForecasts = db.prepare('SELECT id, updated_at FROM main.kpi_forecast').all();
    return {
      tables,
      imports: undone.map((row) => ({ fileName: row.file_name, importedAt: row.imported_at })),
      linesAdded: currentLines.filter((row) => !backupLines.has(row.id)).length,
      linesChanged: currentLines.filter((row) => backupLines.has(row.id) && backupLines.get(row.id) !== row.updated_at).length,
      linesRemoved: [...backupLines.keys()].filter((id) => !currentLineIds.has(id)).length,
      manualEdits: db.prepare('SELECT id FROM main.change_log').all().filter((row) => !keptEdits.has(row.id)).length,
      forecastsChanged: currentForecasts.filter((row) => backupForecasts.get(row.id) !== row.updated_at).length
        + [...backupForecasts.keys()].filter((id) => !currentForecasts.some((row) => row.id === id)).length
    };
  }

  async function preview(name, scopeKey) {
    scopeOf(scopeKey);
    return withSnapshot(name, () => describe(scopeKey));
  }

  // Columns both sides have; a backup from an older version simply lacks the newer ones.
  function sharedColumns(table) {
    const backup = new Set(db.prepare(`SELECT name FROM pragma_table_info(?, 'snap')`).all(table).map((row) => row.name));
    return db.prepare(`SELECT name FROM pragma_table_info(?, 'main')`).all(table).map((row) => row.name).filter((name) => backup.has(name));
  }

  /**
   * Puts the chosen data back as it was in the backup, in one transaction. The current state is
   * backed up first, so the rollback can itself be rolled back from the list.
   */
  function restore(name, scopeKey, { createdBy = '' } = {}) {
    const scope = restoreScopes[scopeKey];
    if (!scope) return Promise.reject(new BackupError('请选择回退台账类数据还是战客清单'));
    const target = list().find((item) => item.name === name);
    if (!target) return Promise.reject(new BackupError('找不到这个备份，可能已按保留规则清理'));
    const run = queue.then(async () => {
      const targetTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(target.createdAt));
      const before = await make('before-restore', {
        detail: `${scope.label}回退到 ${targetTime}（${backupReasons[target.reason]?.label || target.reason}）之前的数据`,
        createdBy
      });
      const summary = await withSnapshot(name, () => {
        const changes = describe(scopeKey);
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const [table] of [...scope.tables].reverse()) db.exec(`DELETE FROM main.${table}`);
          for (const [table] of scope.tables) {
            if (!inSnapshot(table)) continue;
            const columns = sharedColumns(table).map((column) => `"${column}"`).join(', ');
            db.exec(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM snap.${table}`);
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw new BackupError(`回退没有完成，数据保持原样：${error.message}`);
        }
        return changes;
      });
      return { scope: scopeKey, restored: target, before, ...summary };
    });
    queue = run.catch(() => {});
    return run;
  }

  function status() {
    const last = lastWeekly();
    return {
      dir,
      freeBytes: existsSync(dir) ? freeBytes(dir) : freeBytes(dirname(dir)),
      databaseSize: databaseBytes(dbPath),
      reasons: Object.entries(backupReasons).map(([key, item]) => ({ key, ...item })),
      scopes: Object.entries(restoreScopes).map(([key, item]) => ({ key, label: item.label, tables: item.tables.map(([, label]) => label) })),
      lastWeeklyAt: last?.createdAt ?? null,
      nextWeeklyAt: last ? new Date(new Date(last.createdAt).getTime() + 7 * day).toISOString() : null,
      backups: list()
    };
  }

  return { create, list, status, file, weeklyDue, startWeekly, preview, restore };
}

/**
 * Settings page API. A backup holds the whole database, accounts and authenticator secrets
 * included, so downloading one asks for the authenticator code, as does rolling back to one; none
 * of it works through the device certificate port.
 */
export function createBackupRouter({ backups, currentUser, verifyCode, logEvent = () => {} }) {
  const router = Router();

  function record(req, event, detail) {
    logEvent(event, { username: currentUser(req)?.username || '', source: requestSource(req), detail });
  }

  function mainPortOnly(req, res) {
    if (!requestSource(req).startsWith('cert:')) return true;
    res.status(403).json({ error: '通过设备证书端口登录时不能管理备份，请从公司网络访问' });
    return false;
  }

  router.get('/', (req, res) => {
    if (!mainPortOnly(req, res)) return;
    res.json(backups.status());
  });

  router.post('/', async (req, res) => {
    if (!mainPortOnly(req, res)) return;
    try {
      const meta = await backups.create('manual', { detail: '在设置页手动备份', createdBy: currentUser(req)?.username || '' });
      record(req, 'backup_created', meta.name);
      res.status(201).json(meta);
    } catch (error) {
      fail(res, error);
    }
  });

  function codeAccepted(req, res) {
    try {
      if (verifyCode(currentUser(req)?.username, req.body?.code, requestSource(req))) return true;
      res.status(403).json({ error: '验证码不正确，请输入 Google Authenticator 当前显示的 6 位数字' });
    } catch (error) {
      if (!error.status) throw error;
      res.status(error.status).json({ error: error.message });
    }
    return false;
  }

  function fail(res, error) {
    res.status(error instanceof BackupError ? 400 : 500).json({ error: error.message });
  }

  // Reading what a rollback would undo changes nothing, so it needs no code.
  router.post('/:name/restore-preview', async (req, res) => {
    if (!mainPortOnly(req, res)) return;
    if (!backups.file(req.params.name)) return res.status(404).json({ error: '找不到这个备份，可能已按保留规则清理' });
    try {
      res.json(await backups.preview(req.params.name, String(req.body?.scope || '')));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/:name/restore', async (req, res) => {
    if (!mainPortOnly(req, res)) return;
    if (!backups.file(req.params.name)) return res.status(404).json({ error: '找不到这个备份，可能已按保留规则清理' });
    const scope = String(req.body?.scope || '');
    if (!restoreScopes[scope]) return res.status(400).json({ error: '请选择回退台账类数据还是战客清单' });
    if (!codeAccepted(req, res)) return;
    try {
      const result = await backups.restore(req.params.name, scope, { createdBy: currentUser(req)?.username || '' });
      record(req, 'backup_restored', `${restoreScopes[scope].label}回退到 ${req.params.name}；回退前的数据已备份为 ${result.before.name}`);
      res.json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/:name/download', (req, res) => {
    if (!mainPortOnly(req, res)) return;
    const path = backups.file(req.params.name);
    if (!path) return res.status(404).json({ error: '找不到这个备份，可能已按保留规则清理' });
    if (!codeAccepted(req, res)) return;
    record(req, 'backup_downloaded', req.params.name);
    res.setHeader('Cache-Control', 'no-store');
    res.download(path, req.params.name);
  });

  return router;
}
