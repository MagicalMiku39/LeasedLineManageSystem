import { beijingDate } from './utils.js';

// In the order they are shown. The tone follows the ledger's own: new is green, cancelled red.
export const changeTypes = [
  { key: 'added', label: '新增', tone: 'net-positive' },
  { key: 'normalized', label: '转正常' },
  { key: 'resumed', label: '转复机' },
  { key: 'cancelled', label: '转销户', tone: 'net-negative' },
  { key: 'stopped', label: '转停机' },
  { key: 'status', label: '其他状态变化' },
  { key: 'manager', label: '换客户经理' },
  { key: 'fee', label: '资费变化' },
  { key: 'product', label: '产品变化' },
  { key: 'group', label: '集团变化' },
  { key: 'time', label: '时间变化' },
  { key: 'missing', label: '报表里消失', tone: 'net-negative' },
  { key: 'restored', label: '重新出现' }
];

export const changeFieldLabels = {
  product_status_name: '产品状态',
  manager_name: '客户经理',
  manager_job_no: '客户经理工号',
  package_fee: '活动套餐资费',
  product_name: '产品名称',
  group_code: '集团编码',
  group_name: '集团名称',
  start_time: '开始时间',
  status_time: '状态时间'
};

export function changeTypeLabel(type) {
  return changeTypes.find((item) => item.key === type)?.label || type;
}

/** One line for the notice after an import, naming only what actually changed. */
export function changeSummaryText(summary) {
  if (!summary || summary.baseline) return '';
  const parts = changeTypes
    .filter((item) => item.key !== 'added' && summary.counts[item.key] > 0)
    .map((item) => `${item.label} ${summary.counts[item.key]} 条`);
  const net = summary.netBefore !== summary.netAfter
    ? `${summary.year} 年净增 ${summary.netBefore} → ${summary.netAfter}`
    : `${summary.year} 年净增不变（${summary.netAfter}）`;
  return [...parts, net].join('，');
}

/** How current the ledger is: the last import is all the system knows about that. */
export function dataFreshness(importedAt, now = new Date()) {
  if (!importedAt) return '还没有导入过台账';
  const imported = new Date(importedAt);
  if (Number.isNaN(imported.getTime())) return '还没有导入过台账';
  const day = beijingDate(imported);
  const days = Math.round((new Date(beijingDate(now)) - new Date(day)) / 86400000);
  return `数据截至 ${day} 导入${days > 0 ? `（${days} 天前）` : '（今天）'}`;
}
