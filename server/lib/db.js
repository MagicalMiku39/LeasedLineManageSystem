import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { schemaSql } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');
const dataDir = join(rootDir, 'data');
const dbPath = process.env.LEDGER_DB_PATH || join(dataDir, 'ledger.db');

mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(schemaSql);

export function nowIso() {
  return new Date().toISOString();
}

export function makeBatchId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `BATCH-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}
