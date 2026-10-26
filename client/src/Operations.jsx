import React, { useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { Bell, BellOff, Mail, Search } from 'lucide-react';
import { WarningMailDialog, WarningMailSettings } from './WarningMail.jsx';
import { beijingDate, money } from './utils.js';
import './operations.css';

const labels = { unmarked: '未标注', remind: '提醒', ignore: '忽略' };
const levels = { green: '绿色 · 0–89 天', yellow: '黄色 · 90–149 天', red: '红色 · 150–179 天', cancel: '待销户 · ≥180 天' };
export default function Operations({ ref, kpiMode, refreshToken, onOpenLine }) {
  const [asOf, setAsOf] = useState(() => beijingDate());
  const [data, setData] = useState(null);
  const [keyword, setKeyword] = useState('');
  const [mark, setMark] = useState('active');
  const [level, setLevel] = useState('all');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(null);
  const [mailRow, setMailRow] = useState(null);
  const [showMailSettings, setShowMailSettings] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetch(`/api/warnings?${new URLSearchParams({ asOf, kpiMode: kpiMode ? '1' : '0' })}`, { signal: controller.signal })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || '预警加载失败');
        setData(value);
      }).catch((err) => { if (err.name !== 'AbortError') { setError(err.message); setData(null); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [asOf, kpiMode, refreshToken, revision]);
  const rows = useMemo(() => (data?.rows || []).filter((row) => {
    const matches = mark === 'all' || (mark === 'active' ? row.mark !== 'ignore' : row.mark === mark);
    return matches && (level === 'all' || row.warning_level === level) && [row.group_code, row.group_name, row.group_product_code, row.product_code, row.group_product_account_id, row.manager_name].some((value) => String(value || '').toLowerCase().includes(keyword.trim().toLowerCase()));
  }), [data, mark, keyword, level]);
  useImperativeHandle(ref, () => ({
    refresh: () => setRevision((value) => value + 1),
    exportData: async () => {
      if (loading || !rows.length) return;
      try {
        const module = await import('xlsx');
        const XLSX = module.default || module;
        const sheet = XLSX.utils.json_to_sheet(rows.map((row) => ({
          集团编码: row.group_code, 集团名称: row.group_name, 集团产品编码: row.group_product_code,
          产品编码: row.product_code, 产品账户: row.group_product_account_id, 客户经理: row.manager_name,
          停机时间: row.status_time, 统计日期: asOf, 停机天数: row.stopped_days, 预警等级: levels[row.warning_level], 总欠费: row.total_arrears, 标注: labels[row.mark]
        })));
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, '欠费销户预警');
        XLSX.writeFile(book, `欠费销户预警-${asOf}.xlsx`);
      } catch (err) { setError(`导出失败：${err.message}`); }
    }
  }), [rows, loading, asOf]);
  async function saveMark(row, next) {
    setSaving(row.id);
    setError('');
    try {
      const response = await fetch(`/api/warnings/${row.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mark: next }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '标注保存失败');
      setData((current) => current && ({ ...current, rows: current.rows.map((item) => item.id === row.id ? { ...item, mark: result.mark } : item) }));
    } catch (err) { setError(err.message); }
    finally { setSaving(null); }
  }
  return <main className="operations-page">
    <section className="operations-heading">
      <div><p className="operations-eyebrow">运营中心</p><h2>欠费销户预警</h2><p className="operations-rule">停机且总欠费大于 0，按状态日期计算自然日差；满 180 天列为待销户。</p></div>
      <label>统计日期<input type="date" value={asOf} disabled={saving !== null} onChange={(event) => event.target.value && setAsOf(event.target.value)} /></label>
    </section>
    <section className="operations-summary" aria-label="预警概览">
      <div><span>预警专线</span><strong>{loading ? '—' : data?.rows.length ?? '—'}</strong></div>
      <div><span>涉及集团</span><strong>{loading || !data ? '—' : new Set(data.rows.map((row) => row.group_code).filter(Boolean)).size}</strong></div>
      <div><span>已设提醒</span><strong className="operations-remind">{loading || !data ? '—' : data.rows.filter((row) => row.mark === 'remind').length}</strong></div>
      <div><span>已忽略</span><strong>{loading || !data ? '—' : data.rows.filter((row) => row.mark === 'ignore').length}</strong></div>
    </section>
    <div className="operations-filters">
      <label className="operations-search"><Search size={17} /><input aria-label="搜索预警" placeholder="集团、产品编码、账户或客户经理" value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label>
      <label>标注状态<select value={mark} onChange={(event) => setMark(event.target.value)}><option value="active">待关注（不含忽略）</option><option value="all">全部</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>预警等级<select value={level} onChange={(event) => setLevel(event.target.value)}><option value="all">全部等级</option>{Object.entries(levels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <span>{loading ? '加载中' : `${rows.length} 条`}</span>
      <button onClick={() => setShowMailSettings((value) => !value)}><Mail size={16} />客户经理邮箱</button>
    </div>
    {showMailSettings && <WarningMailSettings onClose={() => setShowMailSettings(false)} />}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="operations-error">{error}</p>}
    {!loading && data?.invalidDates > 0 && <p className="operations-rule">{data.invalidDates} 条欠费停机记录的状态时间缺失、无效或晚于统计日期，未纳入预警。</p>}
    <div className="operations-table-wrap"><table><thead><tr>{['集团编码', '集团名称', '集团产品编码', '产品编码', '产品账户', '客户经理', '停机时间', '停机时长', '预警等级', '总欠费', '标注', '操作'].map((title) => <th key={title} className={title === '总欠费' ? 'num' : undefined}>{title}</th>)}</tr></thead>
      <tbody>{!loading && rows.map((row) => <tr key={row.id} className={row.mark === 'ignore' ? 'operations-ignored' : ''}>
        <td>{row.group_code || '—'}</td><td><button className="operations-link" onClick={() => onOpenLine(row.id)}>{row.group_name || '查看专线'}</button></td>
        <td>{row.group_product_code || '—'}</td><td>{row.product_code || '—'}</td><td>{row.group_product_account_id || '—'}</td><td>{row.manager_name || '—'}</td>
        <td>{row.status_time ? row.status_time.slice(0, 10) : '—'}</td><td className={`operations-duration operations-level-${row.warning_level}`}>{row.stopped_days} 天</td><td><span className={`operations-risk operations-level-${row.warning_level}`}>{levels[row.warning_level]}</span></td><td className="num">{money(row.total_arrears)}</td><td>{labels[row.mark]}</td>
        <td><div className="operations-row-actions"><button title="发送欠费预警报告" aria-pressed={row.mark === 'remind'} disabled={saving !== null} onClick={() => { setNotice(''); setMailRow(row); }}><Bell size={15} />提醒</button><button title="忽略此条预警" aria-pressed={row.mark === 'ignore'} disabled={saving !== null} onClick={() => saveMark(row, 'ignore')}><BellOff size={15} />忽略</button>{row.mark !== 'unmarked' && <button disabled={saving !== null} onClick={() => saveMark(row, 'unmarked')}>重置</button>}</div></td>
      </tr>)}{(loading || !rows.length) && <tr><td colSpan="12" className="empty">{loading ? '正在加载预警…' : error ? '预警加载失败，请刷新重试' : '暂无符合条件的预警'}</td></tr>}</tbody>
    </table></div>
    {mailRow && <WarningMailDialog row={mailRow} asOf={asOf} kpiMode={kpiMode} onClose={() => setMailRow(null)} onConfigure={() => { setMailRow(null); setShowMailSettings(true); }} onQueued={(id, result) => {
      setData((current) => current && ({ ...current, rows: current.rows.map((item) => item.id === id ? { ...item, mark: 'remind' } : item) }));
      setNotice(`预警报告已提交至 ${result.recipient} 的发送队列`);
    }} />}
  </main>;
}
