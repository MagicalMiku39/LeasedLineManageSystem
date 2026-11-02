import React, { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { isAbort, requestJson } from './api.js';
import { InlineError } from './components/Feedback.jsx';
import { changeFieldLabels, changeTypeLabel, changeTypes } from './ledgerChanges.js';
import { displayValue } from './utils.js';

function changeValue(row) {
  if (!row.field_name) return '—';
  return (
    <span className="change-value">
      <em>{displayValue(row.old_value)}</em>
      <b aria-label="变为">→</b>
      <em>{displayValue(row.new_value)}</em>
    </span>
  );
}

// What one import changed: a count per kind, each opening its own list.
export default function ImportChanges({ batch, refreshToken, onOpenLine }) {
  const [type, setType] = useState('');
  const [state, setState] = useState({ summary: null, rows: [], hasMore: false, loading: true, error: '' });
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => setType(''), [batch.id]);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));
    requestJson(`/imports/${batch.id}/changes?${new URLSearchParams({ type })}`, { signal: controller.signal })
      .then((value) => setState({ ...value, loading: false, error: '' }))
      .catch((error) => {
        if (!isAbort(error)) setState((current) => ({ ...current, loading: false, error: `变更记录读取失败：${error.message}` }));
      });
    return () => controller.abort();
  }, [batch.id, type, refreshToken, retry]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const before = state.rows[state.rows.length - 1].id;
      const more = await requestJson(`/imports/${batch.id}/changes?${new URLSearchParams({ type, before })}`);
      setState((current) => ({ ...current, rows: [...current.rows, ...more.rows], hasMore: more.hasMore, error: '' }));
    } catch (error) {
      setState((current) => ({ ...current, error: `变更记录读取失败：${error.message}` }));
    } finally {
      setLoadingMore(false);
    }
  }

  const { summary } = state;
  const recorded = Boolean(summary) && !summary.baseline;

  return (
    <section className="table-shell import-detail">
      <div className="table-title">
        <div className="table-title-left">
          <History size={18} aria-hidden="true" />
          <span>变更记录：{batch.file_name}</span>
          {state.loading && <em>加载中</em>}
        </div>
        {recorded && summary.netBefore !== null && (
          <span className="subtle">
            {summary.year} 年 KPI 净增 {summary.netBefore} → {summary.netAfter}
          </span>
        )}
      </div>
      <InlineError message={state.error} onRetry={() => setRetry((value) => value + 1)} />

      {!state.loading && !state.error && !summary && (
        <p className="change-empty">这次导入发生在变更记录功能上线之前，没有记录改了什么。</p>
      )}
      {summary?.baseline && (
        <p className="change-empty">这是第一次导入，作为之后对比的起点，所以没有变更。</p>
      )}

      {recorded && (
        <>
          <div className="change-chips" role="group" aria-label="按变更类型查看">
            <button type="button" aria-pressed={type === ''} onClick={() => setType('')}>全部</button>
            {changeTypes.map((item) => (
              <button key={item.key} type="button" aria-pressed={type === item.key} onClick={() => setType(item.key)}>
                {item.label} <strong className={summary.counts[item.key] > 0 ? item.tone : undefined}>{summary.counts[item.key] || 0}</strong>
              </button>
            ))}
          </div>
          <div className="table-scroll imports-scroll">
            <table className="data-table changes-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>集团名称</th>
                  <th>集团产品编码</th>
                  <th>客户经理</th>
                  <th>字段</th>
                  <th>变化</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((row) => (
                  <tr
                    key={row.id}
                    className={row.line_id ? 'clickable-row' : undefined}
                    tabIndex={row.line_id ? 0 : undefined}
                    onClick={() => { if (row.line_id) onOpenLine(row.line_id); }}
                    onKeyDown={(event) => {
                      if (row.line_id && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        onOpenLine(row.line_id);
                      }
                    }}
                  >
                    <td>{changeTypeLabel(row.change_type)}</td>
                    <td>{displayValue(row.group_name)}</td>
                    <td>{displayValue(row.group_product_code)}</td>
                    <td>{displayValue(row.manager_name)}</td>
                    <td>{changeFieldLabels[row.field_name] || displayValue(row.field_name)}</td>
                    <td>{changeValue(row)}</td>
                    <td>{displayValue(row.note)}</td>
                  </tr>
                ))}
                {state.rows.length === 0 && (
                  <tr className="state-row">
                    <td colSpan="7" className="empty">{state.loading ? '正在读取…' : '这一类没有变更'}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {state.hasMore && (
            <div className="change-more">
              <button type="button" disabled={loadingMore} onClick={loadMore}>{loadingMore ? '加载中…' : '加载更多'}</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
