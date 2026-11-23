import React, { useEffect, useRef, useState } from 'react';
import { Save, X } from 'lucide-react';
import { isAbort, jsonBody, requestJson } from '../api.js';
import { InlineError } from '../components/Feedback.jsx';
import { changeFieldLabels, changeTypeLabel } from '../ledgerChanges.js';
import { beijingTime, displayMoney, displayValue, inputValue } from '../utils.js';
import { batchFields, fieldLabels } from './config.js';

// Fields the drawer edits: every batch-editable field plus renewal and contact details.
const editableKeys = [
  ...batchFields.map((field) => field.key),
  'renewal_status',
  'renewal_reminder_date',
  'customer_contact',
  'customer_phone',
  'ipv4_address',
  'ipv6_address'
];

// What the imported ledger says about the line, shown as it is (it changes only on import).
const importedSections = [
  {
    title: '专线信息',
    fields: [
      ['group_name', '集团名称'],
      ['group_user_name', '专线名称'],
      ['group_product_code', '集团产品编码'],
      ['product_name', '产品名称'],
      ['bandwidth', '专线带宽'],
      ['product_status_name', '产品状态'],
      ['a_end_address', 'A端地址'],
      ['z_end_address', 'Z端地址'],
      ['start_time', '开始时间'],
      ['status_time', '状态时间'],
      ['group_product_account_id', '产品账户ID'],
      ['payment_method_name', '付费方式']
    ]
  },
  {
    title: '套餐与欠费',
    fields: [
      ['package_name', '活动套餐'],
      ['package_fee', '套餐资费', 'money'],
      ['package_effective_time', '套餐生效'],
      ['package_expire_time', '套餐失效'],
      ['total_arrears', '总欠费', 'money']
    ]
  },
  {
    title: '归属信息',
    fields: [
      ['manager_name', '客户经理'],
      ['manager_job_no', '客户经理工号'],
      ['region_name', '归属区分'],
      ['node_name', '归属节点'],
      ['group_level', '集团级别'],
      ['industry_name_1', '行业类别']
    ]
  }
];

const sections = [
  {
    title: '资费信息',
    fields: [
      ['actual_monthly_fee', '实际月资费'],
      ['actual_yearly_fee', '实际年资费'],
      ['one_time_fee', '单次出账费用'],
      ['one_time_fee_name', '单次费用名称'],
      ['one_time_fee_billing_month', '单次费用出账月份', 'month']
    ]
  },
  {
    title: '合同信息',
    fields: [
      ['contract_no', '合同编号'],
      ['contract_start_date', '合同期开始', 'date'],
      ['contract_end_date', '合同期结束', 'date'],
      ['renewal_status', '是否续约'],
      ['renewal_reminder_date', '续约提醒日期', 'date']
    ]
  },
  {
    title: '网络信息',
    note: '可填多个地址，用逗号或空格分隔，可带掩码位数，如 10.1.1.1/30',
    fields: [
      ['ipv4_address', 'IPv4 地址', 'ip'],
      ['ipv6_address', 'IPv6 地址', 'ip']
    ]
  },
  {
    title: '维护信息',
    fields: [
      ['customer_contact', '客户联系人'],
      ['customer_phone', '联系电话'],
      ['operation_owner', '运维负责人'],
      ['business_owner', '商务负责人'],
      ['project_name', '项目归属'],
      ['ledger_status', '台账状态'],
      ['remark', '备注', 'textarea']
    ]
  }
];

function ChangeLog({ logs, error, loading }) {
  if (error) return <InlineError message={`修改记录读取失败：${error}`} />;
  if (loading && logs.length === 0) return <div className="empty-small">正在读取修改记录…</div>;
  if (logs.length === 0) return <div className="empty-small">暂无修改记录</div>;
  return (
    <div className="log-list">
      {logs.map((log) => (
        <div className="log-item" key={log.id}>
          <div>
            <strong>{fieldLabels[log.field_name] || log.field_name}</strong>
            <span>{log.change_source === 'batch' ? '批量编辑' : log.change_source === 'share' ? '链接填报' : '手动编辑'} · {log.changed_by || 'admin'}</span>
          </div>
          <p>
            <em>{log.old_value || '空'}</em>
            <b>→</b>
            <em>{log.new_value || '空'}</em>
          </p>
          <time>{log.changed_at}</time>
        </div>
      ))}
    </div>
  );
}

// What each import changed on this line, newest first.
function ImportHistory({ lineId }) {
  const [state, setState] = useState({ rows: [], loading: true, error: '' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ rows: [], loading: true, error: '' });
    requestJson(`/ledger/${lineId}/changes`, { signal: controller.signal })
      .then((rows) => setState({ rows, loading: false, error: '' }))
      .catch((error) => {
        if (!isAbort(error)) setState({ rows: [], loading: false, error: error.message });
      });
    return () => controller.abort();
  }, [lineId]);

  if (state.error) return <InlineError message={`变更历史读取失败：${state.error}`} />;
  if (state.loading) return <div className="empty-small">正在读取变更历史…</div>;
  if (state.rows.length === 0) return <div className="empty-small">暂无导入变更</div>;
  return (
    <div className="log-list">
      {state.rows.map((row) => (
        <div className="log-item" key={row.id}>
          <div>
            <strong>{changeTypeLabel(row.change_type)}</strong>
            <span>{changeFieldLabels[row.field_name] || row.note || ''}</span>
          </div>
          {row.field_name && (
            <p>
              <em>{row.old_value || '空'}</em>
              <b>→</b>
              <em>{row.new_value || '空'}</em>
            </p>
          )}
          <time>{beijingTime(row.created_at)}</time>
        </div>
      ))}
    </div>
  );
}

export default function DetailDrawer({ record, onClose, onSaved, onOpenGroup }) {
  const [form, setForm] = useState(record || {});
  const [logs, setLogs] = useState([]);
  const [logsState, setLogsState] = useState({ loading: false, error: '', revision: 0 });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const closeButton = useRef(null);

  useEffect(() => {
    setForm(record || {});
    setSaveError('');
  }, [record]);

  useEffect(() => {
    if (record?.id) closeButton.current?.focus();
  }, [record?.id]);

  useEffect(() => {
    if (!record?.id) return undefined;
    const controller = new AbortController();
    setLogsState((current) => ({ ...current, loading: true, error: '' }));
    requestJson(`/ledger/${record.id}/logs`, { signal: controller.signal })
      .then((data) => {
        setLogs(Array.isArray(data) ? data : []);
        setLogsState((current) => ({ ...current, loading: false }));
      })
      .catch((error) => {
        if (!isAbort(error)) setLogsState((current) => ({ ...current, loading: false, error: error.message }));
      });
    return () => controller.abort();
  }, [record?.id, logsState.revision]);

  useEffect(() => {
    if (!record) return undefined;
    function onKeyDown(event) {
      if (event.key === 'Escape' && !saving) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [record, saving, onClose]);

  if (!record) return null;

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  async function save() {
    setSaving(true);
    setSaveError('');
    const editable = Object.fromEntries(editableKeys.map((key) => [key, form[key]]));
    try {
      const data = await requestJson(`/ledger/${record.id}`, jsonBody('PATCH', editable));
      setLogsState((current) => ({ ...current, revision: current.revision + 1 }));
      onSaved(data);
    } catch (error) {
      setSaveError(`保存失败：${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  function renderField([key, label, type]) {
    if (type === 'ip') {
      return <label key={key}>{label}<input inputMode="url" autoCapitalize="off" spellCheck={false} maxLength={500} value={inputValue(form[key])} onChange={(e) => update(key, e.target.value)} /></label>;
    }
    if (type === 'textarea') {
      return <label key={key}>{label}<textarea value={inputValue(form[key])} onChange={(e) => update(key, e.target.value)} /></label>;
    }
    return (
      <label key={key}>
        {label}
        <input type={type || 'text'} value={inputValue(form[key])} onChange={(e) => update(key, e.target.value)} />
      </label>
    );
  }

  return (
    <aside className="drawer" aria-label="专线详情">
      <div className="drawer-header">
        <div>
          <p>
            {record.group_code && onOpenGroup
              ? <button type="button" className="group-link" title="查看集团档案" disabled={saving} onClick={() => onOpenGroup(record.group_code)}>{record.group_code} · 集团档案</button>
              : record.group_code || '未填写集团编码'}
            {' · '}{record.group_product_code || '未填写集团产品编码'}
          </p>
          <h2>{record.group_user_name || record.product_name || '专线详情'}</h2>
        </div>
        <button ref={closeButton} className="icon-button" onClick={onClose} title="关闭" aria-label="关闭详情" disabled={saving}>
          <X size={18} />
        </button>
      </div>

      <div className="drawer-body">
        {importedSections.map((section) => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            <div className="readonly-grid">
              {section.fields.map(([key, label, type]) => (
                <React.Fragment key={key}>
                  <span>{label}</span>
                  <strong className={type === 'money' ? 'readonly-money' : undefined}>{type === 'money' ? displayMoney(record[key]) : displayValue(record[key])}</strong>
                </React.Fragment>
              ))}
            </div>
          </section>
        ))}

        {sections.map((section) => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            {section.note && <p className="drawer-note">{section.note}</p>}
            {section.fields.map(renderField)}
          </section>
        ))}

        <section>
          <h3>导入变更历史</h3>
          <ImportHistory lineId={record.id} />
        </section>

        <section>
          <h3>修改记录</h3>
          <ChangeLog logs={logs} error={logsState.error} loading={logsState.loading} />
        </section>
      </div>

      <div className="drawer-actions">
        <InlineError message={saveError} />
        <button className="primary" onClick={save} disabled={saving}>
          <Save size={16} /> {saving ? '保存中' : '保存'}
        </button>
      </div>
    </aside>
  );
}
