export const visibleColumnsStorageKey = 'ledgerVisibleColumns:v2';
export const columnOrderStorageKey = 'ledgerColumnOrder:v1';
export const ledgerPageSize = 20;

export const defaultManagers = ['张凯', '冯琼', '陈藻麟', '黄训琛', '徐文君', '王瑞迎', '罗艳君', '刘菲', '周明', '张龙', '张雅琦', '喻科', '石佩灵', '张瑾', '尹雪康', '宾琼', '王倩', '曾繁词'];

export const emptyFilters = {
  keyword: '',
  region: [],
  product: [],
  status: [],
  manager: [],
  ledgerStatus: '',
  groupCode: '',
  groupProductCode: '',
  productCode: '',
  bandwidth: '',
  zeroBilling: '',
  contractEndFrom: '',
  contractEndTo: '',
  statFilter: '',
  statMonth: ''
};

// money: true marks amount columns (right-aligned, two decimals). Codes stay text to keep leading zeros.
export const tableColumns = [
  { key: 'group_code', label: '集团编码', defaultVisible: true },
  { key: 'group_name', label: '集团名称', defaultVisible: true },
  { key: 'node_code', label: '归属节点', defaultVisible: false },
  { key: 'node_name', label: '节点名称', defaultVisible: false },
  { key: 'region_name', label: '归属区分', defaultVisible: true },
  { key: 'group_product_code', label: '集团产品编码', defaultVisible: true },
  { key: 'group_user_name', label: '专线名称', defaultVisible: true },
  { key: 'group_product_account_id', label: '集团产品账户ID', defaultVisible: false },
  { key: 'payment_method', label: '付费方式', defaultVisible: false },
  { key: 'payment_method_name', label: '付费方式名称', defaultVisible: false },
  { key: 'product_code', label: '产品编码', defaultVisible: true },
  { key: 'product_name', label: '产品名称', defaultVisible: true },
  { key: 'product_category', label: '产品大类', defaultVisible: false },
  { key: 'start_time', label: '开始时间', defaultVisible: false },
  { key: 'end_time', label: '结束时间', defaultVisible: false },
  { key: 'status_time', label: '状态时间', defaultVisible: false },
  { key: 'product_status', label: '产品状态编码', defaultVisible: false },
  { key: 'product_status_name', label: '产品状态名称', defaultVisible: false },
  { key: 'ledger_status', label: '台账状态', defaultVisible: true, render: (row) => row.ledger_status || row.product_status_name },
  { key: 'is_group_tagged', label: '集团是否打标', defaultVisible: false },
  { key: 'group_level', label: '集团级别', defaultVisible: false },
  { key: 'industry_code_1', label: '集团行业类别1', defaultVisible: false },
  { key: 'industry_name_1', label: '集团行业类别名称1', defaultVisible: false },
  { key: 'industry_code_2', label: '集团行业类别2', defaultVisible: false },
  { key: 'industry_name_2', label: '集团行业类别名称2', defaultVisible: false },
  { key: 'manager_job_no', label: '客户经理工号', defaultVisible: false },
  { key: 'manager_name', label: '客户经理名称', defaultVisible: true },
  { key: 'total_arrears', label: '总欠费', defaultVisible: false, money: true },
  { key: 'source_created_time', label: '创建时间', defaultVisible: false },
  { key: 'last_month_status', label: '上月状态', defaultVisible: false },
  { key: 'two_months_ago_status', label: '上上月状态', defaultVisible: false },
  { key: 'bandwidth', label: '专线带宽', defaultVisible: true },
  { key: 'is_zero_billing_recent_6m', label: '最近半年是否出账为0', defaultVisible: false },
  { key: 'package_code', label: '活动套餐', defaultVisible: false },
  { key: 'package_name', label: '活动套餐名称', defaultVisible: false },
  { key: 'package_fee', label: '活动套餐资费', defaultVisible: true, money: true },
  { key: 'package_effective_time', label: '活动套餐生效时间', defaultVisible: false },
  { key: 'package_expire_time', label: '活动套餐失效时间', defaultVisible: false },
  { key: 'a_end_address', label: 'A端地址', defaultVisible: false },
  { key: 'z_end_address', label: 'Z端地址', defaultVisible: false },
  { key: 'actual_monthly_fee', label: '实际月资费', defaultVisible: true, money: true },
  { key: 'actual_yearly_fee', label: '实际年资费', defaultVisible: false, money: true },
  { key: 'one_time_fee', label: '单次出账费用', defaultVisible: true, money: true },
  { key: 'one_time_fee_name', label: '单次费用名称', defaultVisible: false },
  { key: 'one_time_fee_billing_month', label: '单次出账月份', defaultVisible: true },
  { key: 'contract_no', label: '合同编号', defaultVisible: false },
  { key: 'contract_start_date', label: '合同期开始', defaultVisible: false },
  { key: 'contract_end_date', label: '合同结束', defaultVisible: true },
  { key: 'renewal_status', label: '是否续约', defaultVisible: false },
  { key: 'renewal_reminder_date', label: '续约提醒日期', defaultVisible: false },
  { key: 'customer_contact', label: '客户联系人', defaultVisible: false },
  { key: 'customer_phone', label: '联系电话', defaultVisible: false },
  { key: 'operation_owner', label: '运维负责人', defaultVisible: false },
  { key: 'business_owner', label: '商务负责人', defaultVisible: false },
  { key: 'project_name', label: '项目归属', defaultVisible: false },
  { key: 'remark', label: '备注', defaultVisible: false }
];

export const defaultVisibleColumns = tableColumns.filter((column) => column.defaultVisible).map((column) => column.key);

export const batchFields = [
  { key: 'actual_monthly_fee', label: '实际月资费', type: 'number' },
  { key: 'actual_yearly_fee', label: '实际年资费', type: 'number' },
  { key: 'one_time_fee', label: '单次出账费用', type: 'number' },
  { key: 'one_time_fee_name', label: '单次费用名称', type: 'text' },
  { key: 'one_time_fee_billing_month', label: '单次出账月份', type: 'month' },
  { key: 'contract_no', label: '合同编号', type: 'text' },
  { key: 'contract_start_date', label: '合同期开始', type: 'date' },
  { key: 'contract_end_date', label: '合同期结束', type: 'date' },
  { key: 'ledger_status', label: '台账状态', type: 'text' },
  { key: 'operation_owner', label: '运维负责人', type: 'text' },
  { key: 'business_owner', label: '商务负责人', type: 'text' },
  { key: 'project_name', label: '项目归属', type: 'text' },
  { key: 'remark', label: '备注', type: 'text' }
];

export const fieldLabels = {
  actual_monthly_fee: '实际月资费',
  actual_yearly_fee: '实际年资费',
  one_time_fee: '单次出账费用',
  one_time_fee_name: '单次费用名称',
  one_time_fee_billing_month: '单次出账月份',
  contract_no: '合同编号',
  contract_start_date: '合同期开始',
  contract_end_date: '合同期结束',
  renewal_status: '是否续约',
  renewal_reminder_date: '续约提醒日期',
  customer_contact: '客户联系人',
  customer_phone: '联系电话',
  operation_owner: '运维负责人',
  business_owner: '商务负责人',
  project_name: '项目归属',
  ledger_status: '台账状态',
  remark: '备注'
};

export const advancedFilterKeys = ['groupCode', 'groupProductCode', 'productCode', 'bandwidth', 'zeroBilling', 'contractEndFrom', 'contractEndTo', 'statFilter'];

// Clickable statistics. `filter` is the statFilter sent to /api/ledger; '' clears every filter.
export const statCards = [
  { filter: '', label: '专线总数', field: 'total' },
  { filter: 'active', label: '正常在用', field: 'active' },
  { filter: 'cancelled', label: '已销户', field: 'cancelled' },
  { filter: 'addedInMonth', label: '本月新增', field: 'addedInMonth' },
  { filter: 'cancelledInMonth', label: '本月销户', field: 'cancelledInMonth' },
  { filter: 'stoppedInMonth', label: '本月停机', field: 'stoppedInMonth' }
];
