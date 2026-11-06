// Sorts status changes recorded before v2.1.4 by the current rules (转正常, 转复机, a narrower 转销户):
//
//   node server/scripts/reclassify-ledger-changes.js [--apply]
//
// Without --apply it only prints what would change. With --apply it backs the database up first
// (it appears under 设置 → 备份与恢复) and then updates only the type of those records.
import { db, dbPath } from '../lib/db.js';
import { createBackupService } from '../lib/backup.js';
import { statusChangeType } from '../lib/ledger-changes.js';

const apply = process.argv.includes('--apply');
const rows = db.prepare("SELECT id, old_value, new_value, change_type FROM ledger_change WHERE field_name = 'product_status_name'").all();
const changes = rows
  .map((row) => ({ ...row, next: statusChangeType(row.old_value ?? '', row.new_value ?? '') }))
  .filter((row) => row.next !== row.change_type);

console.log(`状态变化记录 ${rows.length} 条，需要重新分类 ${changes.length} 条`);
for (const row of changes) console.log(`  #${row.id} ${row.old_value || '空'} → ${row.new_value || '空'}：${row.change_type} → ${row.next}`);

if (!apply || changes.length === 0) {
  if (changes.length) console.log('只是预览，没有修改。确认后加 --apply 执行。');
  process.exit(0);
}

const backup = await createBackupService({ db, dbPath }).create('manual', { detail: '重新分类导入变更记录之前' });
console.log(`已备份：${backup.name}`);
const update = db.prepare('UPDATE ledger_change SET change_type = ? WHERE id = ? AND change_type = ?');
db.exec('BEGIN');
try {
  let updated = 0;
  for (const row of changes) updated += Number(update.run(row.next, row.id, row.change_type).changes);
  db.exec('COMMIT');
  console.log(`已重新分类 ${updated} 条`);
} catch (error) {
  db.exec('ROLLBACK');
  console.error(`没有完成，数据保持原样：${error.message}`);
  process.exit(1);
}
