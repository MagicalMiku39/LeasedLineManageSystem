import React, { useEffect, useRef, useState } from 'react';
import { Save, X } from 'lucide-react';
import { isAbort, jsonBody, requestJson } from '../api.js';
import { InlineError } from '../components/Feedback.jsx';
import { displayValue, inputValue } from '../utils.js';
import { batchFields, fieldLabels } from './config.js';

// Fields the drawer edits: every batch-editable field plus renewal and contact details.
const editableKeys = [
  ...batchFields.map((field) => field.key),
  'renewal_status',
  'renewal_reminder_date',
  'customer_contact',
  'customer_phone'
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
    </div>
  );
}

export default function DetailDrawer({ record, onClose, onSaved }) {
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
          <p>{record.group_code || '未填写集团编码'} · {record.group_product_code || '未填写集团产品编码'}</p>
          <h2>{record.group_user_name || record.product_name || '专线详情'}</h2>
        </div>
        <button ref={closeButton} className="icon-button" onClick={onClose} title="关闭" aria-label="关闭详情" disabled={saving}>
          <X size={18} />
        </button>
      </div>

      <div className="drawer-body">
        <section>
          <h3>基础信息</h3>
          <div className="readonly-grid">
            <span>集团名称</span><strong>{displayValue(record.group_name)}</strong>
            <span>产品编码</span><strong>{displayValue(record.product_code)}</strong>
            <span>产品名称</span><strong>{displayValue(record.product_name)}</strong>
            <span>客户经理</span><strong>{displayValue(record.manager_name)}</strong>
          </div>
        </section>

        {sections.map((section) => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            {section.fields.map(renderField)}
          </section>
        ))}

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
