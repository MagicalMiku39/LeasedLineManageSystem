import React, { useEffect, useState } from 'react';
import { FileSpreadsheet, ListChecks } from 'lucide-react';
import { isAbort, requestJson } from './api.js';
import { InlineError } from './components/Feedback.jsx';
import { displayValue } from './utils.js';

function activateOnKey(event, action) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action();
  }
}

function StatusRow({ colSpan, children }) {
  return (
    <tr className="state-row">
      <td colSpan={colSpan} className="empty">{children}</td>
    </tr>
  );
}

// Ledger import batches. Reloads whenever the top bar refreshes or a new ledger file is imported.
export default function ImportRecords({ refreshToken }) {
  const [imports, setImports] = useState({ rows: [], loading: true, error: '' });
  const [retry, setRetry] = useState(0);
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [detail, setDetail] = useState({ rows: [], loading: false, error: '' });

  useEffect(() => {
    const controller = new AbortController();
    setImports((current) => ({ ...current, loading: true, error: '' }));
    requestJson('/imports', { signal: controller.signal })
      .then((rows) => setImports({ rows: Array.isArray(rows) ? rows : [], loading: false, error: '' }))
      .catch((error) => {
        if (!isAbort(error)) setImports((current) => ({ ...current, loading: false, error: `导入记录读取失败：${error.message}` }));
      });
    return () => controller.abort();
  }, [refreshToken, retry]);

  useEffect(() => {
    if (!selectedBatch) return undefined;
    const controller = new AbortController();
    setDetail({ rows: [], loading: true, error: '' });
    requestJson(`/imports/${selectedBatch.id}/rows`, { signal: controller.signal })
      .then((rows) => setDetail({ rows: Array.isArray(rows) ? rows : [], loading: false, error: '' }))
      .catch((error) => {
        if (!isAbort(error)) setDetail({ rows: [], loading: false, error: `导入明细读取失败：${error.message}` });
      });
    return () => controller.abort();
  }, [selectedBatch, refreshToken]);

  const showImportsEmpty = !imports.loading && !imports.error && imports.rows.length === 0;

  return (
    <main className="page">
      <div className="page-heading">
        <h2>导入记录</h2>
        <p>台账 Excel 的每次导入；点击一条记录查看逐行处理结果。</p>
      </div>

      <section className="table-shell">
        <div className="table-title">
          <div className="table-title-left">
            <ListChecks size={18} aria-hidden="true" />
            <span>共 {imports.rows.length} 次导入</span>
            {imports.loading && <em>加载中</em>}
          </div>
        </div>
        <InlineError message={imports.error} onRetry={() => setRetry((value) => value + 1)} />
        <div className="table-scroll imports-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>导入时间</th>
                <th>文件名</th>
                <th>工作表</th>
                <th className="num">总行数</th>
                <th className="num">新增</th>
                <th className="num">更新</th>
                <th className="num">失败</th>
                <th>状态</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {imports.rows.map((item) => (
                <tr
                  key={item.id}
                  className={`clickable-row${selectedBatch?.id === item.id ? ' selected' : ''}`}
                  tabIndex={0}
                  aria-label={`查看 ${item.file_name} 的导入明细`}
                  onClick={() => setSelectedBatch(item)}
                  onKeyDown={(event) => activateOnKey(event, () => setSelectedBatch(item))}
                >
                  <td>{displayValue(item.imported_at)}</td>
                  <td>{displayValue(item.file_name)}</td>
                  <td>{displayValue(item.sheet_name)}</td>
                  <td className="num">{displayValue(item.total_rows)}</td>
                  <td className="num">{displayValue(item.success_rows)}</td>
                  <td className="num">{displayValue(item.updated_rows)}</td>
                  <td className="num">{displayValue(item.failed_rows)}</td>
                  <td><span className="status-pill">{displayValue(item.status)}</span></td>
                  <td>{displayValue(item.message)}</td>
                </tr>
              ))}
              {imports.loading && imports.rows.length === 0 && <StatusRow colSpan={9}>正在读取导入记录…</StatusRow>}
              {showImportsEmpty && <StatusRow colSpan={9}>暂无导入记录</StatusRow>}
            </tbody>
          </table>
        </div>
      </section>

      {selectedBatch && (
        <section className="table-shell import-detail">
          <div className="table-title">
            <div className="table-title-left">
              <FileSpreadsheet size={18} aria-hidden="true" />
              <span>导入明细：{selectedBatch.file_name}</span>
              {detail.loading && <em>加载中</em>}
            </div>
            <span className="subtle">最多显示前 100 条明细</span>
          </div>
          <InlineError message={detail.error} />
          <div className="table-scroll imports-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="num">Excel 行号</th>
                  <th>处理结果</th>
                  <th className="num">关联台账 ID</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {detail.rows.map((row) => (
                  <tr key={`${selectedBatch.id}-${row.row_number}`}>
                    <td className="num">{displayValue(row.row_number)}</td>
                    <td><span className="status-pill">{displayValue(row.result)}</span></td>
                    <td className="num">{displayValue(row.related_line_id)}</td>
                    <td>{displayValue(row.message)}</td>
                  </tr>
                ))}
                {detail.loading && <StatusRow colSpan={4}>正在读取导入明细…</StatusRow>}
                {!detail.loading && !detail.error && detail.rows.length === 0 && <StatusRow colSpan={4}>暂无导入明细</StatusRow>}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
