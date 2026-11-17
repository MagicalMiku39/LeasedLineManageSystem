import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { isAbort, jsonBody, requestJson } from './api.js';
import { InlineError } from './components/Feedback.jsx';
import { confidenceName, confidenceOrder } from './kpiRows.js';

const monthKey = (year, month) => `${year}-${month}`;

/**
 * Changes a registered forecast: month, line count, product type, confidence or group. Only
 * what was changed is sent, and each change is written into the forecast's progress history.
 * Whether it is a new line or a cancellation cannot change: that is a different forecast.
 */
export default function KpiForecastEdit({ row, months, productTypes, currentYear, onClose, onSaved }) {
  const [form, setForm] = useState({
    period: monthKey(row.year, row.month),
    line_count: String(row.line_count),
    product_type: row.product_type,
    confidence: row.confidence || 'unrated',
    group_code: row.group_code
  });
  const [lookup, setLookup] = useState({ code: row.group_code, group: { group_code: row.group_code, group_name: row.group_name, manager_name: row.manager_name } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const first = useRef(null);
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const cancelled = row.kind === 'cancelled';
  const doneWord = cancelled ? '已销户' : '已落地';

  useEffect(() => { first.current?.focus(); }, []);

  // The group the code now names, looked up as it is typed.
  const code = form.group_code.trim();
  useEffect(() => {
    if (code === lookup.code) return undefined;
    if (!code) {
      setLookup({ code, group: null });
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      requestJson(`/kpi/groups?${new URLSearchParams({ q: code })}`, { signal: controller.signal })
        .then((groups) => setLookup({ code, group: groups.find((group) => group.group_code === code) || null }))
        .catch((failure) => { if (!isAbort(failure)) setLookup({ code, group: null }); });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [code, lookup.code]);

  // The forecast's own month stays selectable even once it has passed, so it can be kept.
  const own = monthKey(row.year, row.month);
  const choices = months.some((item) => monthKey(item.year, item.month) === own) ? months : [{ year: row.year, month: row.month, past: true }, ...months];
  const label = (item) => `${item.year === currentYear ? `${item.month}月` : `${item.year}年${item.month}月`}${item.past ? '（已过，原月份）' : item.year > currentYear ? '（明年储备）' : ''}`;
  const groupKnown = code === row.group_code || (lookup.code === code && lookup.group);
  const groupPending = code !== row.group_code && lookup.code !== code;

  async function save(event) {
    event.preventDefault();
    setError('');
    const count = Number(form.line_count);
    if (!Number.isSafeInteger(count) || count <= 0) return setError('预计条数须为正整数');
    if (count < row.landed_count) return setError(`${doneWord} ${row.landed_count} 条，预计条数不能更少`);
    if (!groupKnown) return setError('台账和全量集团清单中都没有这个集团编码');
    const [year, month] = form.period.split('-').map(Number);
    const changes = {};
    if (year !== row.year || month !== row.month) Object.assign(changes, { year, month });
    if (count !== row.line_count) changes.line_count = count;
    if (form.product_type !== row.product_type) changes.product_type = form.product_type;
    if (form.confidence !== (row.confidence || 'unrated')) changes.confidence = form.confidence;
    if (code !== row.group_code) changes.group_code = code;
    if (!Object.keys(changes).length) return onClose();
    setBusy(true);
    try {
      await requestJson(`/kpi/forecasts/${row.id}`, jsonBody('PATCH', changes));
      onSaved();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onClose(); }}>
      <form className="modal kpi-progress-dialog kpi-edit-dialog" role="dialog" aria-modal="true" aria-label="修改预计任务" onSubmit={save}>
        <header className="kpi-progress-head">
          <h3>修改预计{cancelled ? '销户' : '新增'}</h3>
          <button type="button" className="kpi-progress-close" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}><X size={16} /></button>
        </header>
        <div className="kpi-progress-body">
          <div className="kpi-edit-fields">
            <label>
              预计月份
              <select ref={first} value={form.period} disabled={busy} onChange={set('period')}>
                {choices.map((item) => <option key={monthKey(item.year, item.month)} value={monthKey(item.year, item.month)}>{label(item)}</option>)}
              </select>
            </label>
            <label>
              预计条数{row.landed_count > 0 ? `（${doneWord} ${row.landed_count} 条，不能更少）` : ''}
              <input type="number" inputMode="numeric" min={Math.max(1, row.landed_count)} step={1} required value={form.line_count} disabled={busy} onChange={set('line_count')} />
            </label>
            <label>
              产品类型
              <select value={form.product_type} disabled={busy} onChange={set('product_type')}>
                {[...new Set([row.product_type, ...productTypes])].map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label>
              把握度
              <select value={form.confidence} disabled={busy} onChange={set('confidence')}>
                {confidenceOrder.map((level) => <option key={level} value={level}>{confidenceName(row.kind, level)}</option>)}
              </select>
            </label>
            <label className="kpi-edit-wide">
              集团编码
              <input value={form.group_code} disabled={busy} autoComplete="off" onChange={set('group_code')} />
              <small className={groupKnown || groupPending ? undefined : 'kpi-edit-warn'}>
                {groupPending ? '正在查找…'
                  : groupKnown ? `${(code === row.group_code ? row.group_name : lookup.group.group_name)} · 客户经理 ${(code === row.group_code ? row.manager_name : lookup.group.manager_name) || '未填写'}${code !== row.group_code ? '（改集团后客户经理随新集团）' : ''}`
                    : '台账和全量集团清单中都没有这个集团编码'}
              </small>
            </label>
          </div>
          <p className="subtle kpi-edit-note">每项修改都会自动记一条进展，在“查看和更新进展”里能看到改了什么。新增和销户之间不能互改，需要的话请删除后重新登记。</p>
          <InlineError message={error} />
          <div className="kpi-form-actions">
            <button type="button" disabled={busy} onClick={onClose}>取消</button>
            <button type="submit" className="primary" disabled={busy || groupPending}>{busy ? '正在保存…' : '保存修改'}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
