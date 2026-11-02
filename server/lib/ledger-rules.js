// Business definitions shared by the statistics, the KPI page and the import change record.
export const normalStatus = '正常在用';
export const stoppingStatus = '停机执行中';
export const stoppedStatus = '停机';
export const billableStatuses = [normalStatus, stoppingStatus, stoppedStatus];
export const addedStatuses = [
  '欠费销户',
  stoppedStatus,
  stoppingStatus,
  '销户(订单处理中)',
  '销户（订单处理中）',
  normalStatus,
  '正式销户'
];
export const cancelledStatuses = ['欠费销户', '正式销户', '销户(订单处理中)', '销户（订单处理中）'];
export const kpiProductNames = [
  '互联网专线',
  '传输专线',
  'OTN政企专网',
  '跨省互联网专线',
  '国际政企专网专线',
  '新跨省专线产品',
  'SPN专线',
  'MPLS VPN专线',
  '跨国专线A类产品',
  '跨省专线产品'
];
export const kpiProductSqlList = kpiProductNames
  .map((name) => `'${name.replaceAll("'", "''")}'`)
  .join(', ');
