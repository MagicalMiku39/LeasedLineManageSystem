import React, { useEffect, useRef, useState } from 'react';

// Small hand-drawn charts. Every one sits beside the numbers it draws (a table, a metric, a
// legend with counts), so a value is never only in a picture. Colors are the CSS tokens under
// "charts" in app.css: green for new lines, red for cancelled, the warning levels' own colors.

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// Round tick steps (1, 2, 5 × 10ⁿ) giving about `count` ticks between min and max.
function niceTicks(min, max, count = 4) {
  const span = Math.max(max - min, 1);
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((value) => value >= raw);
  const ticks = [];
  for (let value = Math.floor(min / step) * step; value <= max + step / 2; value += step) ticks.push(value);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

const signed = (value) => (value > 0 ? `+${value}` : String(value));

/**
 * The year's net additions month by month, added up: the actual line runs to this month, a
 * reference line climbs evenly to the target, and a dashed line carries on with the forecasts
 * still to land. Hover or arrow keys show one month.
 */
export function KpiTrendChart({ monthly, currentMonth, target, forecastByMonth = {} }) {
  const [box, width] = useWidth();
  const [focus, setFocus] = useState(null);
  const height = 236;
  const margin = { top: 14, right: 64, bottom: 26, left: 40 };
  const plotWidth = Math.max(width - margin.left - margin.right, 1);
  const plotHeight = height - margin.top - margin.bottom;

  let running = 0;
  const actual = [{ month: 0, value: 0 }];
  const rows = monthly.map((row) => {
    running += row.added - row.cancelled;
    if (row.month <= currentMonth) actual.push({ month: row.month, value: running });
    return { ...row, net: row.added - row.cancelled, cumulative: running };
  });
  const current = actual[actual.length - 1];
  const forecastNet = (month) => (forecastByMonth[month]?.added || 0) - (forecastByMonth[month]?.cancelled || 0);
  const hasForecast = Object.keys(forecastByMonth).some((month) => forecastNet(Number(month)) !== 0);
  // Forecasts for this month and earlier ones (overdue but still expected) land in the next
  // point, since this month's point is today's actual.
  const forecast = [];
  if (hasForecast) {
    let expected = current.value;
    let carried = 0;
    for (let month = 1; month <= currentMonth; month += 1) carried += forecastNet(month);
    forecast.push(current);
    if (currentMonth === 12) {
      forecast.push({ month: 12, value: expected + carried });
    } else {
      for (let month = currentMonth + 1; month <= 12; month += 1) {
        expected += forecastNet(month) + (month === currentMonth + 1 ? carried : 0);
        forecast.push({ month, value: expected });
      }
    }
  }
  const pace = (month) => (target * month) / 12;

  const values = [0, target, ...actual.map((point) => point.value), ...forecast.map((point) => point.value)];
  const ticks = niceTicks(Math.min(...values), Math.max(...values), 5);
  const low = ticks[0];
  const high = ticks[ticks.length - 1];
  const x = (month) => margin.left + (month / 12) * plotWidth;
  const y = (value) => margin.top + plotHeight - ((value - low) / (high - low)) * plotHeight;
  const path = (points) => points.map((point, index) => `${index ? 'L' : 'M'}${x(point.month).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');

  // End labels sit at the right edge; the forecast one moves clear of the target's if they meet.
  const targetLabelY = y(target);
  const forecastEnd = forecast[forecast.length - 1];
  let forecastLabelY = forecastEnd ? y(forecastEnd.value) : null;
  if (forecastLabelY !== null && Math.abs(forecastLabelY - targetLabelY) < 14) forecastLabelY = targetLabelY + (forecastLabelY >= targetLabelY ? 14 : -14);

  function pick(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const month = Math.round(((event.clientX - rect.left - margin.left) / plotWidth) * 12);
    setFocus(Math.min(12, Math.max(1, month)));
  }

  function keys(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setFocus((value) => Math.min(12, Math.max(1, (value ?? currentMonth) + (event.key === 'ArrowRight' ? 1 : -1))));
  }

  const focused = focus ? rows[focus - 1] : null;
  const focusedForecast = focus && focus > currentMonth ? forecast.find((point) => point.month === focus) : null;

  return (
    <figure className="chart">
      <div className="chart-legend" aria-hidden="true">
        <span><i className="chart-key chart-key-actual" />实际累计净增</span>
        <span><i className="chart-key chart-key-reference" />目标进度（全年匀速）</span>
        {hasForecast && <span><i className="chart-key chart-key-forecast" />计入未落地预计</span>}
      </div>
      <div
        ref={box}
        className="chart-plot"
        tabIndex={0}
        role="img"
        aria-label={`截至 ${currentMonth} 月累计净增 ${current.value}，按目标匀速应为 ${Math.round(pace(currentMonth))}，全年目标 ${target}。左右方向键逐月查看。`}
        onKeyDown={keys}
        onBlur={() => setFocus(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} onMouseMove={pick} onMouseLeave={() => setFocus(null)}>
            {ticks.map((tick) => (
              <g key={tick}>
                <line className="chart-grid" x1={margin.left} x2={margin.left + plotWidth} y1={y(tick)} y2={y(tick)} />
                <text className="chart-tick" x={margin.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">{tick}</text>
              </g>
            ))}
            {rows.map((row) => (
              <text key={row.month} className="chart-tick" x={x(row.month)} y={height - 6} textAnchor="middle">
                {width < 420 && row.month % 3 !== 0 ? '' : `${row.month}月`}
              </text>
            ))}
            {focus && <line className="chart-crosshair" x1={x(focus)} x2={x(focus)} y1={margin.top} y2={margin.top + plotHeight} />}
            <path className="chart-line chart-line-reference" d={path([{ month: 0, value: 0 }, { month: 12, value: target }])} />
            {forecast.length > 1 && <path className="chart-line chart-line-forecast" d={path(forecast)} />}
            <path className="chart-line chart-line-actual" d={path(actual)} />
            <circle className="chart-dot chart-dot-actual" cx={x(current.month)} cy={y(current.value)} r={4.5} />
            {forecastEnd && forecast.length > 1 && <circle className="chart-dot chart-dot-forecast" cx={x(forecastEnd.month)} cy={y(forecastEnd.value)} r={4.5} />}
            {focus && focused && focus <= currentMonth && <circle className="chart-dot chart-dot-actual" cx={x(focus)} cy={y(focused.cumulative)} r={4.5} />}
            {/* Above and to the left of today's point: the line arrives from the lower left, and the
                right edge belongs to the target and forecast labels. */}
            <text className="chart-label" x={x(current.month) + (current.month <= 1 ? 8 : -8)} y={y(current.value) - 10} textAnchor={current.month <= 1 ? 'start' : 'end'}>{current.value}</text>
            <text className="chart-label chart-label-muted" x={margin.left + plotWidth + 8} y={targetLabelY} dominantBaseline="middle">目标 {target}</text>
            {forecastEnd && forecast.length > 1 && <text className="chart-label chart-label-muted" x={margin.left + plotWidth + 8} y={forecastLabelY} dominantBaseline="middle">预计 {forecastEnd.value}</text>}
          </svg>
        )}
        {focused && (
          <div className="chart-tooltip" style={{ left: Math.min(Math.max(x(focus), 90), Math.max(width - 90, 90)) }}>
            <strong>{focused.month} 月</strong>
            {focus <= currentMonth ? (
              <>
                <span>新增 {focused.added} · 销户 {focused.cancelled} · 当月净增 {signed(focused.net)}</span>
                <span>累计净增 {focused.cumulative}{focus === currentMonth ? '（截至今日）' : ''}</span>
              </>
            ) : (
              <span>{focusedForecast ? `计入预计后累计 ${focusedForecast.value}` : '尚未到这个月'}</span>
            )}
            <span>目标进度 {Math.round(pace(focus))}</span>
          </div>
        )}
      </div>
    </figure>
  );
}

/**
 * One row's new lines against its cancelled ones, on a scale shared by every row: cancelled
 * grows left from the middle, new grows right. The numbers are in the row's own cells.
 */
export function PolarityBar({ added, cancelled, max }) {
  const share = (value) => (max > 0 ? `${(value / max) * 100}%` : '0%');
  return (
    <span className="polarity-bar" aria-hidden="true" title={`新增 ${added} · 销户 ${cancelled}`}>
      <span className="polarity-half polarity-left"><i style={{ width: share(cancelled) }} /></span>
      <span className="polarity-half polarity-right"><i style={{ width: share(added) }} /></span>
    </span>
  );
}

/**
 * One whole split into parts, widths proportional to the values. `thin` is the 8px row
 * version with no text; otherwise a 28px bar with each part's share printed where it fits. With
 * `onSelect` every part is a button, and `selected` marks the chosen one.
 */
export function SegmentBar({ segments, label, thin = false, onSelect, selected, printValues = false }) {
  const total = segments.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return <span className={`segment-bar segment-empty${thin ? ' segment-thin' : ''}`} aria-label={`${label}：0`} />;
  return (
    <span className={`segment-bar${thin ? ' segment-thin' : ''}`} role={onSelect ? 'group' : 'img'} aria-label={`${label}：${segments.map((item) => `${item.label} ${item.value}`).join('，')}`}>
      {segments.filter((item) => item.value > 0).map((item) => {
        const share = item.value / total;
        const text = `${Math.round(share * 100)}%`;
        // A label prints inside only where it fits even on a phone; the legend has every count.
        const content = !thin && share >= 0.15 ? <span className="segment-text">{printValues ? item.value : text}</span> : null;
        const props = {
          key: item.key,
          className: `segment segment-${item.tone}${selected && selected !== item.key ? ' segment-dim' : ''}`,
          style: { flexGrow: item.value },
          title: `${item.label} ${item.value}（${text}）`
        };
        return onSelect
          ? <button type="button" {...props} aria-pressed={selected === item.key} aria-label={`${item.label} ${item.value}`} onClick={() => onSelect(item.key)}>{content}</button>
          : <span {...props}>{content}</span>;
      })}
    </span>
  );
}

/** The names and counts of a SegmentBar's parts, in the bar's order; clickable with onSelect. */
export function SegmentLegend({ segments, onSelect, selected }) {
  return (
    <span className="segment-legend">
      {segments.map((item) => {
        const body = <><i className={`segment-swatch segment-${item.tone}`} />{item.label}<strong>{item.value}</strong></>;
        return onSelect
          ? <button key={item.key} type="button" aria-pressed={selected === item.key} onClick={() => onSelect(item.key)}>{body}</button>
          : <span key={item.key}>{body}</span>;
      })}
    </span>
  );
}

/**
 * Progress toward a target: the solid part is done, the lighter part is what the forecasts would
 * add, on a track in a lighter step of the same blue. Past the target the bar is simply full; the
 * legend carries the exact figures.
 */
export function ProgressMeter({ value, forecast = 0, target, valueLabel = '当前净增', forecastLabel = '计入预计' }) {
  const clamp = (share) => Math.max(0, Math.min(1, share));
  const done = target > 0 ? clamp(value / target) : 0;
  const more = target > 0 && forecast > 0 ? clamp((value + forecast) / target) - done : 0;
  return (
    <div className="meter-block">
      <div className="meter" role="img" aria-label={`${valueLabel} ${value}${forecast ? `，${forecastLabel}后 ${value + forecast}` : ''}，目标 ${target}`}>
        <span className="meter-done" style={{ width: `${done * 100}%` }} />
        {more > 0 && <span className="meter-more" style={{ width: `${more * 100}%` }} />}
      </div>
      <p className="meter-legend">
        <span><i className="meter-key meter-key-done" />{valueLabel} <strong>{value}</strong></span>
        {forecast > 0 && <span><i className="meter-key meter-key-more" />{forecastLabel} <strong>{value + forecast}</strong></span>}
        <span className="meter-target">目标 <strong>{target}</strong></span>
      </p>
    </div>
  );
}

/**
 * A few series per period as upright columns on one shared scale: periods run left to right and
 * each value is printed above its columns in text colors. A negative value draws in red from the
 * same baseline and keeps its sign. With many periods the figure scrolls inside its own box.
 */
export function GroupedBars({ rows, series, format = String, label }) {
  const max = Math.max(0, ...rows.flatMap((row) => series.map((item) => Math.abs(row.values[item.key] ?? 0))));
  const height = (value) => `${max > 0 ? (Math.abs(value ?? 0) / max) * 100 : 0}%`;
  // Where the periods do not all fit, the view opens on the latest ones.
  const scroller = useRef(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [rows.length]);
  return (
    <figure className="chart grouped-bars" aria-label={label}>
      <div className="chart-legend">
        {series.map((item) => <span key={item.key}><i className={`grouped-swatch grouped-${item.key}`} />{item.label}</span>)}
      </div>
      <div className="grouped-scroll" ref={scroller} tabIndex={0} role="group" aria-label={`${label}，月份从左到右`}>
        <div className="grouped-columns">
          {rows.map((row) => (
            <div key={row.key} className="grouped-column">
              <span className="grouped-values">
                {series.map((item, index) => (
                  index === 0
                    ? <strong key={item.key}>{format(row.values[item.key])}</strong>
                    : <span key={item.key}>{format(row.values[item.key])}</span>
                ))}
              </span>
              <span className="grouped-plot">
                {series.map((item) => {
                  const value = row.values[item.key];
                  return <i key={item.key} className={`grouped-bar grouped-${item.key}${value < 0 ? ' grouped-negative' : ''}${value ? ' grouped-some' : ''}`} style={{ height: height(value) }} title={`${item.label} ${format(value)}`} />;
                })}
              </span>
              <span className="grouped-label">{row.label}{row.sublabel && <small>{row.sublabel}</small>}</span>
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}

/**
 * How much of the year has gone by against how much of the target is done, as two bars on the
 * same 0–100% scale, with the shortfall (or lead) against an even pace in words.
 */
export function PaceCompare({ pace, value, target }) {
  const done = target > 0 ? Math.max(0, value / target) : 0;
  const behind = pace.expected - value;
  const width = (share) => `${Math.min(1, Math.max(0, share)) * 100}%`;
  return (
    <div className="pace">
      <div className="pace-row">
        <span className="pace-label">时间进度</span>
        <span className="pace-track"><i className="pace-time" style={{ width: width(pace.elapsed) }} /></span>
        <span className="pace-value">{Math.round(pace.elapsed * 100)}%<small>已过 {pace.dayOfYear}/{pace.daysInYear} 天</small></span>
      </div>
      <div className="pace-row">
        <span className="pace-label">KPI 完成</span>
        <span className="pace-track"><i className="pace-done" style={{ width: width(done) }} /></span>
        <span className="pace-value">{(done * 100).toFixed(1)}%<small>{value} / {target}</small></span>
      </div>
      <p className="pace-summary">
        按时间进度应完成 <strong>{pace.expected}</strong> 条，
        {behind > 0 ? <>当前落后 <strong className="net-negative">{behind}</strong> 条</> : behind < 0 ? <>当前领先 <strong className="net-positive">{-behind}</strong> 条</> : '与时间进度持平'}。
      </p>
    </div>
  );
}
