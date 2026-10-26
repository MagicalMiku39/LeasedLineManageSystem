import React, { useEffect, useState } from 'react';
import { Save, X } from 'lucide-react';
import { jsonBody, requestJson } from '../api.js';
import { InlineError } from '../components/Feedback.jsx';
import { inputValue } from '../utils.js';
import { batchFields } from './config.js';

export default function BatchModal({ ids, onClose, onSaved }) {
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape' && !saving) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [saving, onClose]);

  async function save() {
    setSaving(true);
    setError('');
    try {
      const result = await requestJson('/ledger/batch', jsonBody('PATCH', { ids, values }));
      onSaved(result);
    } catch (failure) {
      setError(`批量保存失败：${failure.message}`);
      setSaving(false);
    }
  }

  return (
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="batch-modal-title">
        <div className="drawer-header">
          <div>
            <p>已选择 {ids.length} 条记录</p>
            <h2 id="batch-modal-title">批量编辑</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭" aria-label="关闭批量编辑" disabled={saving}><X size={18} /></button>
        </div>
        <div className="modal-body">
          {batchFields.map((field) => (
            <label key={field.key}>
              {field.label}
              <input
                type={field.type}
                value={inputValue(values[field.key])}
                onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
              />
            </label>
          ))}
          <p className="hint">空白字段不会被批量更新。</p>
        </div>
        <div className="drawer-actions">
          <InlineError message={error} />
          <button className="primary" onClick={save} disabled={saving}>
            <Save size={16} /> {saving ? '保存中' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
