import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { isAbort, jsonBody, requestJson } from './api.js';
import { InlineError } from './components/Feedback.jsx';
import { forecastState } from './kpiRows.js';
import { beijingTime, displayValue } from './utils.js';

const maxNote = 500;

// One forecast's history and the form that adds to it. Updates are only ever added, never edited.
export default function KpiProgress({ forecastId, onClose, onChanged }) {
  const [state, setState] = useState({ forecast: null, entries: [], suggestions: [], loading: true, error: '' });
  const [deciding, setDeciding] = useState(null);
  const [matchError, setMatchError] = useState('');
  const [retry, setRetry] = useState(0);
  const [note, setNote] = useState('');
  const [landedCount, setLandedCount] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));
    requestJson(`/kpi/forecasts/${forecastId}/progress`, { signal: controller.signal })
      .then((value) => setState({ ...value, loading: false, error: '' }))
      .catch((err) => {
        if (!isAbort(err)) setState((current) => ({ ...current, loading: false, error: `进展读取失败：${err.message}` }));
      });
    return () => controller.abort();
  }, [forecastId, retry]);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setSaveError('');
    try {
      await requestJson(`/kpi/forecasts/${forecastId}/progress`, jsonBody('POST', { note, landed_count: landedCount }));
      setNote('');
      setLandedCount('');
      setRetry((value) => value + 1);
      onChanged();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function decide(line, action) {
    setDeciding(line.line_id);
    setMatchError('');
    try {
      await requestJson(`/kpi/forecasts/${forecastId}/matches`, jsonBody('POST', { line_id: line.line_id, action }));
      setRetry((value) => value + 1);
      onChanged();
    } catch (err) {
      setMatchError(err.message);
    } finally {
      setDeciding(null);
    }
  }

  const { forecast, entries, suggestions } = state;
  const countWord = forecast?.kind === 'cancelled' ? '已销户' : '已落地';

  return (
    <div className="modal-mask" onKeyDown={(event) => { if (event.key === 'Escape' && !saving) onClose(); }}>
      <div className="modal kpi-progress-dialog" role="dialog" aria-modal="true" aria-label="任务进展">
        <header className="kpi-progress-head">
          <h3>{forecast ? forecast.group_name : '任务进展'}</h3>
          <button type="button" className="kpi-progress-close" aria-label="关闭" title="关闭" disabled={saving} onClick={onClose}><X size={16} /></button>
        </header>

        <div className="kpi-progress-body">
          <InlineError message={state.error} onRetry={() => setRetry((value) => value + 1)} />
          {!forecast && state.loading && <p className="subtle" role="status">正在读取…</p>}

          {forecast && (
            <>
              <dl className="kpi-progress-facts">
                <dt>集团编码</dt>
                <dd>{forecast.group_code}</dd>
                <dt>客户经理</dt>
                <dd>{forecast.manager_name}</dd>
                <dt>类型</dt>
                <dd>{forecast.product_type}</dd>
                <dt>预计</dt>
                <dd>{forecast.month}月{forecast.kind === 'cancelled' ? '销户' : '新增'} {forecast.line_count} 条</dd>
                <dt>进度</dt>
                <dd>{forecastState(forecast)}：{countWord} {forecast.landed_count} 条，还有 {forecast.remaining} 条计入预计</dd>
              </dl>

              {suggestions.length > 0 && (
                <section className="kpi-suggestions" aria-label="可能对应的专线">
                  <h4>可能对应的专线（{suggestions.length}）</h4>
                  <p className="subtle">这个集团在你登记之后{forecast.kind === 'cancelled' ? '有这些专线销户' : '导入了这些新专线'}。是否对应这个任务由你确认，确认后才计入{countWord}条数。</p>
                  <InlineError message={matchError} />
                  <ul>
                    {suggestions.map((line) => (
                      <li key={line.line_id}>
                        <div>
                          <strong>{line.group_product_code}</strong>
                          <span>
                            {line.product_name}
                            {!line.sameProduct && <em> · 和预计类型不同</em>}
                            {' · '}{forecast.kind === 'cancelled' ? `状态时间 ${displayValue(line.status_time)}` : `开始时间 ${displayValue(line.start_time)}`}
                            {' · '}{displayValue(line.status)}
                          </span>
                          <span>{beijingTime(line.imported_at)} 导入</span>
                        </div>
                        <div className="kpi-suggestion-actions">
                          <button type="button" className="primary" disabled={deciding !== null} onClick={() => decide(line, 'confirm')}>确认{forecast.kind === 'cancelled' ? '销户' : '落地'}</button>
                          <button type="button" disabled={deciding !== null} onClick={() => decide(line, 'dismiss')}>不是这条</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <form className="kpi-progress-form" onSubmit={submit}>
                <label>
                  进展说明
                  <textarea
                    autoFocus
                    required
                    maxLength={maxNote}
                    value={note}
                    placeholder="例如：已签合同，等施工"
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
                <label>
                  {countWord}条数
                  <input
                    type="number"
                    min="0"
                    max={forecast.line_count}
                    step="1"
                    inputMode="numeric"
                    value={landedCount}
                    placeholder={`不填则保持 ${forecast.landed_count}`}
                    onChange={(event) => setLandedCount(event.target.value)}
                  />
                </label>
                <InlineError message={saveError} />
                <div className="kpi-progress-submit">
                  <span className="subtle">更新时间由系统自动记录</span>
                  <button type="submit" className="primary" disabled={saving}>{saving ? '保存中…' : '更新进展'}</button>
                </div>
              </form>

              <h4>历史进展（{entries.length}）</h4>
              {entries.length === 0 ? (
                <p className="subtle">还没有进展记录</p>
              ) : (
                <ol className="kpi-progress-list">
                  {entries.map((entry) => (
                    <li key={entry.id}>
                      <p className="kpi-progress-meta">
                        {beijingTime(entry.created_at)} · {entry.created_by || '—'}
                        {entry.landed_count !== null && ` · ${countWord} ${entry.landed_count}/${forecast.line_count}`}
                      </p>
                      <p className="kpi-progress-note">{entry.note}</p>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
