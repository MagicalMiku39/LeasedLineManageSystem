import { Router } from 'express';
import { createWarningMailRouter } from './warning-mail.js';

function calendarDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(String(value || ''));
  if (!match) return null;
  const [, year, part, day] = match.map(Number);
  const date = new Date(Date.UTC(year, part - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== part - 1 || date.getUTCDate() !== day) return null;
  return date.getTime();
}

export function stoppedDays(value, asOf) {
  const start = calendarDay(value);
  const end = calendarDay(asOf);
  if (start === null || end === null || start > end) return null;
  return (end - start) / 86400000;
}

export function warningLevel(days) {
  if (days >= 180) return 'cancel';
  if (days >= 150) return 'red';
  if (days >= 90) return 'yellow';
  return 'green';
}

export function createWarningsRouter({ db, leasedLineSource, currentUser }) {
  const router = Router();
  db.exec(`CREATE TABLE IF NOT EXISTS line_warning_mark (
    line_id INTEGER PRIMARY KEY REFERENCES leased_line(id) ON DELETE CASCADE,
    mark TEXT NOT NULL CHECK(mark IN ('remind', 'ignore')),
    updated_by TEXT, updated_at TEXT NOT NULL
  )`);
  router.use(createWarningMailRouter({ db, leasedLineSource, currentUser, stoppedDays, warningLevel }));
  router.get('/', (req, res) => {
    const asOf = String(req.query.asOf ?? new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date()));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || calendarDay(asOf) === null) return res.status(400).json({ error: '统计日期不正确' });
    const candidates = db.prepare(`SELECT l.id, l.group_code, l.group_name, l.group_product_code,
      l.product_code, l.product_name, l.group_product_account_id, l.manager_name,
      l.status_time, l.total_arrears, COALESCE(m.mark, 'unmarked') AS mark
      FROM ${leasedLineSource(req.query)} l LEFT JOIN line_warning_mark m ON m.line_id = l.id
      WHERE l.product_status_name = '停机' AND l.total_arrears > 0`).all();
    let invalidDates = 0;
    const rows = candidates.flatMap((row) => {
      const duration = stoppedDays(row.status_time, asOf);
      if (duration === null) invalidDates++;
      return duration !== null ? [{ ...row, stopped_days: duration, warning_level: warningLevel(duration) }] : [];
    }).sort((a, b) => b.stopped_days - a.stopped_days || b.total_arrears - a.total_arrears || a.id - b.id);
    res.json({ asOf, rows, invalidDates });
  });
  router.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    const mark = req.body?.mark;
    if (!Number.isSafeInteger(id) || id <= 0 || !['unmarked', 'remind', 'ignore'].includes(mark)) return res.status(400).json({ error: '标注参数不正确' });
    if (!db.prepare('SELECT id FROM leased_line WHERE id = ?').get(id)) return res.status(404).json({ error: '专线不存在' });
    if (mark === 'unmarked') db.prepare('DELETE FROM line_warning_mark WHERE line_id = ?').run(id);
    else db.prepare(`INSERT INTO line_warning_mark(line_id, mark, updated_by, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(line_id) DO UPDATE SET mark=excluded.mark, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(id, mark, currentUser(req)?.username || '', new Date().toISOString());
    res.json({ id, mark });
  });
  return router;
}
