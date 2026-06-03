import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BarChart3,
  CheckSquare,
  Columns3,
  Download,
  FileSpreadsheet,
  History,
  ListChecks,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Upload,
  X
} from 'lucide-react';
import './styles.css';

const apiBase = 'http://127.0.0.1:3001/api';
const visibleColumnsStorageKey = 'ledgerVisibleColumns:v2';

const emptyFilters = {
  keyword: '',
  region: '',
  product: '',
  status: '',
  manager: '',
  ledgerStatus: '',
  groupCode: '',
  groupProductCode: '',
  productCode: '',
  bandwidth: '',
  zeroBilling: '',
  contractEndFrom: '',
  contractEndTo: ''
};

const tableColumns = [
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
  { key: 'total_arrears', label: '总欠费', defaultVisible: false },
  { key: 'source_created_time', label: '创建时间', defaultVisible: false },
  { key: 'last_month_status', label: '上月状态', defaultVisible: false },
  { key: 'two_months_ago_status', label: '上上月状态', defaultVisible: false },
  { key: 'bandwidth', label: '专线带宽', defaultVisible: true },
  { key: 'is_zero_billing_recent_6m', label: '最近半年是否出账为0', defaultVisible: false },
  { key: 'package_code', label: '活动套餐', defaultVisible: false },
  { key: 'package_name', label: '活动套餐名称', defaultVisible: false },
  { key: 'package_fee', label: '活动套餐资费', defaultVisible: true },
  { key: 'package_effective_time', label: '活动套餐生效时间', defaultVisible: false },
  { key: 'package_expire_time', label: '活动套餐失效时间', defaultVisible: false },
  { key: 'a_end_address', label: 'A端地址', defaultVisible: false },
  { key: 'z_end_address', label: 'Z端地址', defaultVisible: false },
  { key: 'actual_monthly_fee', label: '实际月资费', defaultVisible: true },
  { key: 'actual_yearly_fee', label: '实际年资费', defaultVisible: false },
  { key: 'one_time_fee', label: '单次出账费用', defaultVisible: true },
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

const defaultVisibleColumns = tableColumns.filter((column) => column.defaultVisible).map((column) => column.key);

const batchFields = [
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

const fieldLabels = {
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

function money(value) {
  const number = Number(value || 0);
  return number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function StatCard({ label, value, suffix }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}{suffix || ''}</strong>
    </div>
  );
}

function SelectFilter({ value, onChange, options, label }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
      <option value="">{label}</option>
      {options.map((option) => (
        <option key={option} value={option}>{option}</option>
      ))}
    </select>
  );
}

function DetailDrawer({ record, onClose, onSaved }) {
  const [form, setForm] = useState(record || {});
  const [logs, setLogs] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => setForm(record || {}), [record]);

  useEffect(() => {
    if (!record?.id) return;
    fetch(`${apiBase}/ledger/${record.id}/logs`)
      .then((response) => response.json())
      .then((data) => setLogs(Array.isArray(data) ? data : []));
  }, [record?.id]);

  if (!record) return null;

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  async function loadLogs() {
    if (!record?.id) return;
    const response = await fetch(`${apiBase}/ledger/${record.id}/logs`);
    const data = await response.json();
    setLogs(Array.isArray(data) ? data : []);
  }

  async function save() {
    setSaving(true);
    const editable = Object.fromEntries(batchFields.map((field) => [field.key, form[field.key]]));
    Object.assign(editable, {
      renewal_status: form.renewal_status,
      renewal_reminder_date: form.renewal_reminder_date,
      customer_contact: form.customer_contact,
      customer_phone: form.customer_phone
    });

    const response = await fetch(`${apiBase}/ledger/${record.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editable)
    });
    const data = await response.json();
    setSaving(false);
    await loadLogs();
    onSaved(data);
  }

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div>
          <p>{record.group_code || '未填写集团编码'} · {record.group_product_code || '未填写集团产品编码'}</p>
          <h2>{record.group_user_name || record.product_name || '专线详情'}</h2>
        </div>
        <button className="icon-button" onClick={onClose} title="关闭">
          <X size={18} />
        </button>
      </div>

      <div className="drawer-body">
        <section>
          <h3>基础信息</h3>
          <div className="readonly-grid">
            <span>集团名称</span><strong>{record.group_name || '-'}</strong>
            <span>产品编码</span><strong>{record.product_code || '-'}</strong>
            <span>产品名称</span><strong>{record.product_name || '-'}</strong>
            <span>客户经理</span><strong>{record.manager_name || '-'}</strong>
          </div>
        </section>

        <section>
          <h3>资费信息</h3>
          <label>实际月资费<input value={form.actual_monthly_fee || ''} onChange={(e) => update('actual_monthly_fee', e.target.value)} /></label>
          <label>实际年资费<input value={form.actual_yearly_fee || ''} onChange={(e) => update('actual_yearly_fee', e.target.value)} /></label>
          <label>单次出账费用<input value={form.one_time_fee || ''} onChange={(e) => update('one_time_fee', e.target.value)} /></label>
          <label>单次费用名称<input value={form.one_time_fee_name || ''} onChange={(e) => update('one_time_fee_name', e.target.value)} /></label>
          <label>单次费用出账月份<input type="month" value={form.one_time_fee_billing_month || ''} onChange={(e) => update('one_time_fee_billing_month', e.target.value)} /></label>
        </section>

        <section>
          <h3>合同信息</h3>
          <label>合同编号<input value={form.contract_no || ''} onChange={(e) => update('contract_no', e.target.value)} /></label>
          <label>合同期开始<input type="date" value={form.contract_start_date || ''} onChange={(e) => update('contract_start_date', e.target.value)} /></label>
          <label>合同期结束<input type="date" value={form.contract_end_date || ''} onChange={(e) => update('contract_end_date', e.target.value)} /></label>
          <label>是否续约<input value={form.renewal_status || ''} onChange={(e) => update('renewal_status', e.target.value)} /></label>
          <label>续约提醒日期<input type="date" value={form.renewal_reminder_date || ''} onChange={(e) => update('renewal_reminder_date', e.target.value)} /></label>
        </section>

        <section>
          <h3>维护信息</h3>
          <label>客户联系人<input value={form.customer_contact || ''} onChange={(e) => update('customer_contact', e.target.value)} /></label>
          <label>联系电话<input value={form.customer_phone || ''} onChange={(e) => update('customer_phone', e.target.value)} /></label>
          <label>运维负责人<input value={form.operation_owner || ''} onChange={(e) => update('operation_owner', e.target.value)} /></label>
          <label>商务负责人<input value={form.business_owner || ''} onChange={(e) => update('business_owner', e.target.value)} /></label>
          <label>项目归属<input value={form.project_name || ''} onChange={(e) => update('project_name', e.target.value)} /></label>
          <label>台账状态<input value={form.ledger_status || ''} onChange={(e) => update('ledger_status', e.target.value)} /></label>
          <label>备注<textarea value={form.remark || ''} onChange={(e) => update('remark', e.target.value)} /></label>
        </section>

        <section>
          <h3>修改记录</h3>
          <div className="log-list">
            {logs.map((log) => (
              <div className="log-item" key={log.id}>
                <div>
                  <strong>{fieldLabels[log.field_name] || log.field_name}</strong>
                  <span>{log.change_source === 'batch' ? '批量编辑' : '手动编辑'} · {log.changed_by || 'admin'}</span>
                </div>
                <p>
                  <em>{log.old_value || '空'}</em>
                  <b>→</b>
                  <em>{log.new_value || '空'}</em>
                </p>
                <time>{log.changed_at}</time>
              </div>
            ))}
            {logs.length === 0 && <div className="empty-small">暂无修改记录</div>}
          </div>
        </section>
      </div>

      <div className="drawer-actions">
        <button className="primary" onClick={save} disabled={saving}>
          <Save size={16} /> {saving ? '保存中' : '保存'}
        </button>
      </div>
    </aside>
  );
}

function ImportRecords() {
  const [imports, setImports] = useState([]);
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [rows, setRows] = useState([]);
  const [loadingRows, setLoadingRows] = useState(false);

  async function loadImports() {
    const response = await fetch(`${apiBase}/imports`);
    setImports(await response.json());
  }

  async function openBatch(batch) {
    setSelectedBatch(batch);
    setLoadingRows(true);
    const response = await fetch(`${apiBase}/imports/${batch.id}/rows`);
    setRows(await response.json());
    setLoadingRows(false);
  }

  useEffect(() => {
    loadImports();
  }, []);

  return (
    <main>
      <section className="table-shell">
        <div className="table-title">
          <div className="table-title-left">
            <ListChecks size={18} />
            <span>导入记录</span>
          </div>
          <button onClick={loadImports}>
            <RefreshCw size={16} /> 刷新
          </button>
        </div>
        <div className="table-scroll imports-scroll">
          <table>
            <thead>
              <tr>
                <th>导入时间</th>
                <th>文件名</th>
                <th>工作表</th>
                <th>总行数</th>
                <th>新增</th>
                <th>更新</th>
                <th>失败</th>
                <th>状态</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((item) => (
                <tr key={item.id} onClick={() => openBatch(item)}>
                  <td>{item.imported_at}</td>
                  <td>{item.file_name}</td>
                  <td>{item.sheet_name}</td>
                  <td>{item.total_rows}</td>
                  <td>{item.success_rows}</td>
                  <td>{item.updated_rows}</td>
                  <td>{item.failed_rows}</td>
                  <td><span className="status-pill">{item.status}</span></td>
                  <td>{item.message}</td>
                </tr>
              ))}
              {imports.length === 0 && (
                <tr>
                  <td colSpan="9" className="empty">暂无导入记录</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selectedBatch && (
        <section className="table-shell import-detail">
          <div className="table-title">
            <div className="table-title-left">
              <FileSpreadsheet size={18} />
              <span>导入明细：{selectedBatch.file_name}</span>
              {loadingRows && <em>加载中</em>}
            </div>
            <span className="subtle">最多显示前 100 条明细</span>
          </div>
          <div className="table-scroll imports-scroll">
            <table>
              <thead>
                <tr>
                  <th>Excel 行号</th>
                  <th>处理结果</th>
                  <th>关联台账 ID</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${selectedBatch.id}-${row.row_number}`}>
                    <td>{row.row_number}</td>
                    <td><span className="status-pill">{row.result}</span></td>
                    <td>{row.related_line_id || ''}</td>
                    <td>{row.message}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan="4" className="empty">暂无导入明细</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

function BatchModal({ ids, onClose, onSaved }) {
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const response = await fetch(`${apiBase}/ledger/batch`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, values })
    });
    const data = await response.json();
    setSaving(false);
    if (data.error) {
      alert(data.error);
      return;
    }
    onSaved();
  }

  return (
    <div className="modal-mask">
      <div className="modal">
        <div className="drawer-header">
          <div>
            <p>已选择 {ids.length} 条记录</p>
            <h2>批量编辑</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭"><X size={18} /></button>
        </div>
        <div className="modal-body">
          {batchFields.map((field) => (
            <label key={field.key}>
              {field.label}
              <input
                type={field.type}
                value={values[field.key] || ''}
                onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
              />
            </label>
          ))}
          <p className="hint">空白字段不会被批量更新。</p>
        </div>
        <div className="drawer-actions">
          <button className="primary" onClick={save} disabled={saving}>
            <Save size={16} /> {saving ? '保存中' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [activeView, setActiveView] = useState('ledger');
  const [filters, setFilters] = useState(emptyFilters);
  const [options, setOptions] = useState({ regions: [], products: [], statuses: [], managers: [], ledgerStatuses: [] });
  const [stats, setStats] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState(() => {
    const saved = localStorage.getItem(visibleColumnsStorageKey);
    return saved ? JSON.parse(saved) : defaultVisibleColumns;
  });

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ page, pageSize: 20 });
    Object.entries(filters).forEach(([key, value]) => value && params.set(key, value));
    return params.toString();
  }, [filters, page]);

  const filterQueryString = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => value && params.set(key, value));
    return params.toString();
  }, [filters]);

  const activeColumns = tableColumns.filter((column) => visibleColumns.includes(column.key));
  const advancedFilterCount = [
    filters.groupCode,
    filters.groupProductCode,
    filters.productCode,
    filters.bandwidth,
    filters.zeroBilling,
    filters.contractEndFrom,
    filters.contractEndTo
  ].filter(Boolean).length;

  function updateFilter(key, value) {
    setPage(1);
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function loadLedger() {
    setLoading(true);
    const response = await fetch(`${apiBase}/ledger?${queryString}`);
    const data = await response.json();
    setRows(data.rows || []);
    setTotal(data.total || 0);
    setSelectedIds([]);
    setLoading(false);
  }

  async function loadStats() {
    const response = await fetch(`${apiBase}/stats?month=${month}`);
    setStats(await response.json());
  }

  async function loadOptions() {
    const response = await fetch(`${apiBase}/options`);
    setOptions(await response.json());
  }

  useEffect(() => {
    localStorage.setItem(visibleColumnsStorageKey, JSON.stringify(visibleColumns));
  }, [visibleColumns]);

  useEffect(() => {
    loadLedger();
  }, [queryString]);

  useEffect(() => {
    loadStats();
  }, [month]);

  useEffect(() => {
    loadOptions();
  }, []);

  async function uploadExcel(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch(`${apiBase}/import`, { method: 'POST', body: formData });
    const data = await response.json();
    setUploading(false);
    event.target.value = '';
    if (data.error) {
      alert(data.error);
      return;
    }
    alert(`导入完成：新增 ${data.successRows} 条，更新 ${data.updatedRows} 条，失败 ${data.failedRows} 条`);
    loadLedger();
    loadStats();
    loadOptions();
  }

  async function openDetail(id) {
    const response = await fetch(`${apiBase}/ledger/${id}`);
    setSelected(await response.json());
  }

  function toggleColumn(key) {
    setVisibleColumns((current) => {
      if (current.includes(key)) return current.filter((item) => item !== key);
      return [...current, key];
    });
  }

  function toggleRow(id) {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      return [...current, id];
    });
  }

  function toggleAllRows(checked) {
    setSelectedIds(checked ? rows.map((row) => row.id) : []);
  }

  function exportLedger() {
    window.location.href = `${apiBase}/ledger/export?${filterQueryString}`;
  }

  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="app">
      <header>
        <div>
          <p>专线台账管理系统</p>
          <h1>台账工作台</h1>
        </div>
        <div className="header-actions">
          <div className="view-tabs">
            <button className={activeView === 'ledger' ? 'active' : ''} onClick={() => setActiveView('ledger')}>
              <FileSpreadsheet size={16} /> 台账
            </button>
            <button className={activeView === 'imports' ? 'active' : ''} onClick={() => setActiveView('imports')}>
              <History size={16} /> 导入记录
            </button>
          </div>
          <label className="upload-button">
            <Upload size={16} />
            {uploading ? '导入中' : '导入 Excel'}
            <input type="file" accept=".xlsx,.xls" onChange={uploadExcel} disabled={uploading} />
          </label>
          <button onClick={exportLedger}>
            <Download size={16} /> 导出
          </button>
          <button onClick={() => { loadLedger(); loadStats(); loadOptions(); }}>
            <RefreshCw size={16} /> 刷新
          </button>
        </div>
      </header>

      {activeView === 'imports' ? <ImportRecords /> : <main>
        <section className="stats-band">
          <div className="month-picker">
            <div className="month-picker-label">
              <BarChart3 size={18} />
              <span>统计月份</span>
            </div>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
          <StatCard label="专线总数" value={stats?.total || 0} />
          <StatCard label="正常在用" value={stats?.active || 0} />
          <StatCard label="已销户" value={stats?.cancelled || 0} />
          <StatCard label="本月新增" value={stats?.addedInMonth || 0} />
          <StatCard label="本月销户" value={stats?.cancelledInMonth || 0} />
          <StatCard label="本月停机" value={stats?.stoppedInMonth || 0} />
          <StatCard label="预计总出账" value={money(stats?.expectedTotalBilling)} suffix=" 元" />
        </section>

        <section className="toolbar">
          <div className="search-box">
            <Search size={18} />
            <input
              value={filters.keyword}
              onChange={(event) => updateFilter('keyword', event.target.value)}
              placeholder="搜索集团编码、产品编码、客户、产品、经理、地址"
            />
          </div>
          <SelectFilter label="归属区分" value={filters.region} options={options.regions || []} onChange={(value) => updateFilter('region', value)} />
          <SelectFilter label="产品名称" value={filters.product} options={options.products || []} onChange={(value) => updateFilter('product', value)} />
          <SelectFilter label="产品状态" value={filters.status} options={options.statuses || []} onChange={(value) => updateFilter('status', value)} />
          <SelectFilter label="客户经理" value={filters.manager} options={options.managers || []} onChange={(value) => updateFilter('manager', value)} />
          <button onClick={() => { setPage(1); setFilters(emptyFilters); }}>清空</button>
        </section>

        <section className="advanced-filter-shell">
          <button className="advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
            <SlidersHorizontal size={16} />
            高级筛选
            {advancedFilterCount > 0 && <span>{advancedFilterCount}</span>}
          </button>
          {showAdvanced && (
            <div className="advanced-filters">
              <label>
                集团编码
                <input value={filters.groupCode} onChange={(event) => updateFilter('groupCode', event.target.value)} placeholder="支持模糊匹配" />
              </label>
              <label>
                集团产品编码
                <input value={filters.groupProductCode} onChange={(event) => updateFilter('groupProductCode', event.target.value)} placeholder="支持模糊匹配" />
              </label>
              <label>
                产品编码
                <input value={filters.productCode} onChange={(event) => updateFilter('productCode', event.target.value)} placeholder="如 pg.dt.zx.cs" />
              </label>
              <label>
                专线带宽
                <input value={filters.bandwidth} onChange={(event) => updateFilter('bandwidth', event.target.value)} placeholder="如 10M、100" />
              </label>
              <label>
                最近半年出账为 0
                <select value={filters.zeroBilling} onChange={(event) => updateFilter('zeroBilling', event.target.value)}>
                  <option value="">全部</option>
                  {(options.zeroBillingOptions || []).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label>
                合同到期起
                <input type="date" value={filters.contractEndFrom} onChange={(event) => updateFilter('contractEndFrom', event.target.value)} />
              </label>
              <label>
                合同到期止
                <input type="date" value={filters.contractEndTo} onChange={(event) => updateFilter('contractEndTo', event.target.value)} />
              </label>
            </div>
          )}
        </section>

        <section className="table-shell">
          <div className="table-title">
            <div className="table-title-left">
              <FileSpreadsheet size={18} />
              <span>共 {total} 条记录</span>
              {loading && <em>加载中</em>}
              {selectedIds.length > 0 && <strong>已选 {selectedIds.length} 条</strong>}
            </div>
            <div className="table-actions">
              <button disabled={selectedIds.length === 0} onClick={() => setShowBatch(true)}>
                <CheckSquare size={16} /> 批量编辑
              </button>
              <div className="column-menu-wrap">
                <button onClick={() => setShowColumns(!showColumns)}>
                  <Columns3 size={16} /> 显示字段
                </button>
                {showColumns && (
                  <div className="column-menu">
                    {tableColumns.map((column) => (
                      <label key={column.key}>
                        <input
                          type="checkbox"
                          checked={visibleColumns.includes(column.key)}
                          onChange={() => toggleColumn(column.key)}
                        />
                        {column.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="select-cell">
                    <input
                      type="checkbox"
                      checked={rows.length > 0 && selectedIds.length === rows.length}
                      onChange={(event) => toggleAllRows(event.target.checked)}
                    />
                  </th>
                  {activeColumns.map((column) => <th key={column.key}>{column.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} onClick={() => openDetail(row.id)}>
                    <td className="select-cell" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(row.id)}
                        onChange={() => toggleRow(row.id)}
                      />
                    </td>
                    {activeColumns.map((column) => {
                      const value = column.render ? column.render(row) : row[column.key];
                      return (
                        <td key={column.key}>
                          {column.key === 'ledger_status' ? <span className="status-pill">{value || '-'}</span> : (value ?? '')}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={activeColumns.length + 1} className="empty">暂无数据，请先导入 Excel</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <span>{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        </section>
      </main>}

      <DetailDrawer
        record={selected}
        onClose={() => setSelected(null)}
        onSaved={(record) => {
          setSelected(record);
          loadLedger();
          loadStats();
        }}
      />

      {showBatch && (
        <BatchModal
          ids={selectedIds}
          onClose={() => setShowBatch(false)}
          onSaved={() => {
            setShowBatch(false);
            loadLedger();
            loadStats();
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
