import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { jsonBody, requestJson } from './api.js';
import { InlineError } from './components/Feedback.jsx';

const maxNote = 200;

/**
 * Closes a forecast. 已完结 means it came true, with as many lines as actually landed (all of
 * them unless told otherwise). 未完结 means it will not go further: what landed stays and a
 * reason is kept. Either way the lines that did not land stop counting. Nothing is deleted; it
 * moves to the archived list and can be reopened.
 */
export default function KpiArchive({ row, reasons, words, onClose, onSaved }) {
  const [status, setStatus] = useState('');
  const [landed, setLanded] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const first = useRef(null);
  const cancelled = row.kind === 'cancelled';
  const doneWord = cancelled ? '已销户' : '已落地';
  const verb = cancelled ? '销户' : '落地';

  useEffect(() => { first.current?.focus(); }, []);

  // Choosing a result fills in its usual count: all for 已完结, what has landed for 未完结.
  function choose(next) {
    setStatus(next);
    setLanded(String(next === 'done' ? row.line_count : row.landed_count));
    setError('');
  }

  const count = Number(landed);
  const valid = landed !== '' && Number.isSafeInteger(count) && count >= 0 && count <= row.line_count;
  const rest = valid ? row.line_count - count : null;

  async function save(event) {
    event.preventDefault();
    setError('');
    if (!status) return setError('请选择已完结或未完结');
    if (!valid) return setError(`最终${verb}条数须为 0–${row.line_count} 的整数`);
    if (status === 'done' && count === 0) return setError(`已完结至少要有 1 条${doneWord}；一条都没有请选未完结`);
    if (status === 'dropped' && !reason) return setError('请选择未完结的原因');
    if (status === 'dropped' && reason === '其他' && !note.trim()) return setError('原因选“其他”时请填写说明');
    setBusy(true);
    try {
      await requestJson(`/kpi/forecasts/${row.id}/archive`, jsonBody('POST', {
        status, landed_count: count, reason: status === 'dropped' ? reason : '', note: note.trim()
      }));
      onSaved();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onClose(); }}>
      <form className="modal kpi-progress-dialog kpi-edit-dialog" role="dialog" aria-modal="true" aria-label="归档预计任务" onSubmit={save}>
        <header className="kpi-progress-head">
          <h3>归档：{row.group_name}</h3>
          <button type="button" className="kpi-progress-close" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}><X size={16} /></button>
        </header>
        <div className="kpi-progress-body">
          <p className="subtle kpi-archive-facts">
            {row.year}年{row.month}月 · 预计{cancelled ? '销户' : '新增'} {row.product_type} {row.line_count} 条，目前{doneWord} {row.landed_count} 条
          </p>
          <fieldset className="kpi-archive-choices" disabled={busy}>
            <legend>结果</legend>
            <label className={status === 'done' ? 'kpi-archive-chosen' : undefined}>
              <input ref={first} type="radio" name="archive-status" checked={status === 'done'} onChange={() => choose('done')} />
              <span>
                <strong>{words.done}</strong>
                <small>这单做成了。实际{verb}的条数可以少于预计。</small>
              </span>
            </label>
            <label className={status === 'dropped' ? 'kpi-archive-chosen' : undefined}>
              <input type="radio" name="archive-status" checked={status === 'dropped'} onChange={() => choose('dropped')} />
              <span>
                <strong>{words.dropped}</strong>
                <small>不会再往下走了，需要选原因。已经{verb}的条数照样保留。</small>
              </span>
            </label>
          </fieldset>
          {status && (
            <div className="kpi-edit-fields kpi-archive-reason">
              <label>
                最终{verb}条数
                <input type="number" inputMode="numeric" min={status === 'done' ? 1 : 0} max={row.line_count} step={1} required value={landed} disabled={busy} onChange={(event) => setLanded(event.target.value)} />
              </label>
              <p className={`kpi-archive-result${valid ? '' : ' kpi-edit-warn'}`} role="status">
                {valid
                  ? `${verb} ${count} 条${rest > 0 ? `，其余 ${rest} 条不再计入预计` : '，全部完成'}`
                  : `请填 0–${row.line_count} 的整数`}
              </p>
              {status === 'dropped' && (
                <label className="kpi-edit-wide">
                  原因
                  <select value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} required>
                    <option value="">选择原因</option>
                    {reasons.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
              )}
              <label className="kpi-edit-wide">
                说明{status === 'dropped' && reason === '其他' ? '' : '（选填）'}
                <textarea rows={2} maxLength={maxNote} value={note} disabled={busy} placeholder={status === 'dropped' ? '例如：客户选择了友商的报价' : '例如：客户只开通了 5 条，其余暂不需要'} onChange={(event) => setNote(event.target.value)} />
              </label>
            </div>
          )}
          <p className="subtle kpi-edit-note">归档不是删除：会移到下方“已归档”，不再计入预计达成，随时可以取消归档（恢复到归档前的{verb}条数）。归档会自动记一条进展。</p>
          <InlineError message={error} />
          <div className="kpi-form-actions">
            <button type="button" disabled={busy} onClick={onClose}>取消</button>
            <button type="submit" className="primary" disabled={busy || !status}>{busy ? '正在归档…' : '归档'}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
