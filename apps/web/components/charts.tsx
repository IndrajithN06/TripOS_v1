'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';

/* ---------- helpers ---------- */
export function useWidth<T extends HTMLElement>(min = 260) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(min);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(min, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export const compact = (n: number) => new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const compactInr = (n: number | string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 1 }).format(Number(n));
export const wholeInr = (n: number | string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(n));
/** Axis max such that 4 equal ticks are whole numbers (these are counts). */
const niceMax = (v: number) => { const raw = Math.max(1, v) / 4; const p = 10 ** Math.floor(Math.log10(raw)); const step = [1, 2, 5, 10].map((m) => Math.max(1, Math.round(m * p))).find((s) => s >= raw) ?? 10 * p; return step * 4; };
const fmtDay = (d: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'));

interface Tip { x: number; y: number; node: React.ReactNode }
function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const show = useCallback((e: { clientX: number; clientY: number }, node: React.ReactNode) => {
    const r = box.current?.getBoundingClientRect();
    if (r) setTip({ x: e.clientX - r.left, y: e.clientY - r.top, node });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  const el = tip && (
    <div className="v-tip" role="tooltip" style={{ left: Math.min(tip.x + 14, (box.current?.clientWidth ?? 400) - 190), top: Math.max(tip.y - 12, 0) }}>{tip.node}</div>
  );
  return { box, show, hide, el };
}

/* ---------- Sparkline ---------- */
export function Sparkline({ values, color = 'var(--v-s1)', label }: { values: number[]; color?: string; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>(40);
  const h = 40, max = Math.max(1, ...values), n = values.length;
  if (n < 2) return <div ref={ref} style={{ height: h }} />;
  const pts = values.map((v, i) => [2 + (i * (w - 4)) / (n - 1), h - 4 - (v / max) * (h - 10)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[n - 1];
  return (
    <div ref={ref} style={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>
      <svg width={w} height={h} style={{ display: 'block' }} role="img" aria-label={label}>
        <path d={`${d} L${lx},${h} L2,${h} Z`} fill={color} opacity=".1" />
        <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={lx} cy={ly} r="4" fill={color} stroke="var(--v-surface)" strokeWidth="2" />
      </svg>
    </div>
  );
}

/* ---------- Trend (line + wash, crosshair, tooltip, keyboard) ---------- */
export interface TrendSeries { key: string; label: string; color: string; values: number[] }
export function TrendChart({ dates, series, height = 270 }: { dates: string[]; series: TrendSeries[]; height?: number }) {
  const [wrap, w] = useWidth<HTMLDivElement>();
  const { box, show, hide, el } = useTip();
  const [idx, setIdx] = useState<number | null>(null);
  const ml = 34, mr = 40, mt = 14, mb = 26, n = dates.length;
  const innerW = w - ml - mr, innerH = height - mt - mb;
  const yMax = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const x = (i: number) => ml + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const y = (v: number) => mt + innerH - (v / yMax) * innerH;
  const ticks = [0, 1, 2, 3, 4].map((t) => (yMax / 4) * t);
  const xTicks = Array.from(new Set(Array.from({ length: Math.min(6, n) }, (_, k) => Math.round((k * (n - 1)) / Math.max(1, Math.min(6, n) - 1)))));
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  // direct end labels, only where they do not collide
  const ends = series.map((s) => ({ s, y: y(s.values[n - 1] ?? 0) })).sort((a, b) => a.y - b.y);
  const labelled = new Set<string>(); let lastY = -99;
  for (const e of ends) if (e.y - lastY >= 14) { labelled.add(e.s.key); lastY = e.y; }

  const nearest = (clientX: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.round(((clientX - r.left - ml) / Math.max(1, innerW)) * (n - 1))));
  };
  const tipNode = (i: number) => (
    <>
      <div className="v-tip-h">{fmtDay(dates[i])}</div>
      {series.map((s) => (
        <div className="v-tip-r" key={s.key}><span className="v-key" style={{ background: s.color }} /><strong>{s.values[i]}</strong><span>{s.label}</span></div>
      ))}
    </>
  );
  return (
    <div ref={box} className="v-box">
      <div ref={wrap}>
        <svg width={w} height={height} tabIndex={0} role="img" aria-label={`Trend of ${series.map((s) => s.label).join(', ')} by day. Use left and right arrow keys to read values.`}
          onPointerMove={(e) => { const i = nearest(e.clientX); setIdx(i); show(e, tipNode(i)); }} onPointerLeave={() => { setIdx(null); hide(); }}
          onFocus={() => setIdx(n - 1)} onBlur={() => setIdx(null)}
          onKeyDown={(e) => { if (e.key === 'ArrowLeft') setIdx((v) => Math.max(0, (v ?? n) - 1)); if (e.key === 'ArrowRight') setIdx((v) => Math.min(n - 1, (v ?? -1) + 1)); }}>
          {ticks.map((t) => (<g key={t}><line x1={ml} x2={w - mr} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--v-axis)' : 'var(--v-grid)'} strokeWidth="1" /><text x={ml - 8} y={y(t) + 4} textAnchor="end" className="v-axis">{compact(t)}</text></g>))}
          {xTicks.map((i) => <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="v-axis">{fmtDay(dates[i])}</text>)}
          <path d={`${path(series[0].values)} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={series[0].color} opacity=".1" />
          {series.map((s) => <path key={s.key} d={path(s.values)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
          {series.map((s) => labelled.has(s.key) && n > 0 && (
            <g key={s.key + 'end'}><circle cx={x(n - 1)} cy={y(s.values[n - 1])} r="4" fill={s.color} stroke="var(--v-surface)" strokeWidth="2" /><text x={x(n - 1) + 9} y={y(s.values[n - 1]) + 4} className="v-end">{s.values[n - 1]}</text></g>
          ))}
          {idx !== null && (
            <g pointerEvents="none">
              <line x1={x(idx)} x2={x(idx)} y1={mt} y2={mt + innerH} stroke="var(--v-axis)" strokeWidth="1" />
              {series.map((s) => <circle key={s.key} cx={x(idx)} cy={y(s.values[idx])} r="4.5" fill={s.color} stroke="var(--v-surface)" strokeWidth="2" />)}
            </g>
          )}
        </svg>
      </div>
      {el}
      {idx !== null && <div className="v-sr" aria-live="polite">{fmtDay(dates[idx])}: {series.map((s) => `${s.label} ${s.values[idx]}`).join(', ')}</div>}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; note?: string }[] }) {
  return <div className="v-legend">{items.map((i) => <span key={i.label}><span className="v-swatch" style={{ background: i.color }} />{i.label}{i.note && <em>{i.note}</em>}</span>)}</div>;
}

/* ---------- Funnel (ordinal single-hue ramp) ---------- */
export function FunnelChart({ stages }: { stages: { stage: string; value: number }[] }) {
  const { box, show, hide, el } = useTip();
  const max = Math.max(1, stages[0]?.value ?? 1);
  return (
    <div ref={box} className="v-box v-funnel">
      {stages.map((s, i) => {
        const pct = stages[i - 1] ? (stages[i - 1].value ? Math.round((s.value / stages[i - 1].value) * 100) : 0) : null;
        return (
          <div key={s.stage} className="v-frow">
            <div className="v-flabel">{s.stage}</div>
            <div className="v-ftrack">
              <div className="v-fbar" tabIndex={0} style={{ width: `${Math.max(2, (s.value / max) * 100)}%`, background: `var(--v-f${i})` }}
                onPointerMove={(e) => show(e, <><div className="v-tip-h">{s.stage}</div><div className="v-tip-r"><strong>{s.value}</strong><span>{pct !== null ? `${pct}% of ${stages[i - 1].stage.toLowerCase()}` : 'top of funnel'}</span></div></>)}
                onPointerLeave={hide} onFocus={(e) => { const r = e.currentTarget.getBoundingClientRect(); show({ clientX: r.right, clientY: r.top }, <><div className="v-tip-h">{s.stage}</div><div className="v-tip-r"><strong>{s.value}</strong></div></>); }} onBlur={hide} aria-label={`${s.stage}: ${s.value}`} />
              <span className="v-fval">{s.value}</span>
            </div>
            <div className="v-fpct">{pct !== null ? `${pct}%` : ''}</div>
          </div>
        );
      })}
      {el}
    </div>
  );
}

/* ---------- Horizontal bars ---------- */
export function HBars({ rows, color = 'var(--v-s1)' }: { rows: { label: string; value: number; display: string; sub?: string }[]; color?: string }) {
  const { box, show, hide, el } = useTip();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div ref={box} className="v-box v-hbars">
      {rows.map((r) => (
        <div className="v-hrow" key={r.label}>
          <div className="v-hlabel" title={r.label}>{r.label}</div>
          <div className="v-htrack">
            <div className="v-hbar" tabIndex={0} aria-label={`${r.label}: ${r.display}${r.sub ? `, ${r.sub}` : ''}`} style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: color }}
              onPointerMove={(e) => show(e, <><div className="v-tip-h">{r.label}</div><div className="v-tip-r"><strong>{r.display}</strong><span>{r.sub}</span></div></>)} onPointerLeave={hide} />
            <span className="v-hval">{r.display}</span>
          </div>
        </div>
      ))}
      {el}
    </div>
  );
}

/* ---------- Segmented (stacked) bar with legend table ---------- */
export function SegmentBar({ parts }: { parts: { label: string; value: number; color: string; mark: string }[] }) {
  const { box, show, hide, el } = useTip();
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div ref={box} className="v-box">
      <div className="v-seg" role="img" aria-label={`Quote status split: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}`}>
        {parts.filter((p) => p.value > 0).map((p) => (
          <div key={p.label} tabIndex={0} className="v-segpart" style={{ flexGrow: p.value, background: p.color }} aria-label={`${p.label}: ${p.value}`}
            onPointerMove={(e) => show(e, <><div className="v-tip-h">{p.label}</div><div className="v-tip-r"><strong>{p.value}</strong><span>{Math.round((p.value / total) * 100)}%</span></div></>)} onPointerLeave={hide} />
        ))}
      </div>
      <table className="v-leg-table"><tbody>
        {parts.map((p) => (
          <tr key={p.label}><td><span className="v-swatch" style={{ background: p.color }} />{p.mark} {p.label}</td><td className="right mono"><strong>{p.value}</strong></td><td className="right mono muted">{Math.round((p.value / total) * 100)}%</td></tr>
        ))}
      </tbody></table>
      {el}
    </div>
  );
}

/* ---------- Heatmap (sequential single hue) ---------- */
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
export function Heatmap({ data }: { data: number[][] }) {
  const { box, show, hide, el } = useTip();
  const max = Math.max(1, ...data.flat());
  const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first
  const bucket = (v: number) => (v === 0 ? -1 : Math.min(6, Math.floor((v / max) * 6.999)));
  return (
    <div ref={box} className="v-box">
      <div className="v-heat" role="img" aria-label="Inbound messages by weekday and hour">
        <div />
        {Array.from({ length: 24 }, (_, h) => <div key={h} className="v-hh">{h % 3 === 0 ? hourLabel(h) : ''}</div>)}
        {order.map((d) => (
          <React.Fragment key={d}>
            <div className="v-hd">{DOW[d]}</div>
            {data[d].map((v, h) => {
              const b = bucket(v);
              return <div key={h} className="v-cell" tabIndex={v ? 0 : -1} style={{ background: b < 0 ? 'var(--v-empty)' : `var(--v-h${b})` }} aria-label={`${DOW[d]} ${hourLabel(h)}: ${v} messages`}
                onPointerMove={(e) => show(e, <><div className="v-tip-h">{DOW[d]}, {hourLabel(h)}</div><div className="v-tip-r"><strong>{v}</strong><span>inbound messages</span></div></>)} onPointerLeave={hide} />;
            })}
          </React.Fragment>
        ))}
      </div>
      <div className="v-scale"><span>Fewer</span>{[0, 1, 2, 3, 4, 5, 6].map((b) => <i key={b} style={{ background: `var(--v-h${b})` }} />)}<span>More</span></div>
      {el}
    </div>
  );
}

/* ---------- Card with chart/table switch ---------- */
export function ChartCard({ title, subtitle, children, table, legend, className = '' }: {
  title: string; subtitle?: string; children: React.ReactNode; table?: { head: string[]; rows: (string | number)[][] }; legend?: React.ReactNode; className?: string;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <section className={`card v-card ${className}`}>
      <header className="v-head">
        <div><h2>{title}</h2>{subtitle && <div className="muted small">{subtitle}</div>}</div>
        {table && <div className="v-switch" role="group" aria-label={`${title} view`}>
          <button aria-pressed={view === 'chart'} onClick={() => setView('chart')}>Chart</button><button aria-pressed={view === 'table'} onClick={() => setView('table')}>Table</button></div>}
      </header>
      {view === 'chart' || !table ? <>{legend}{children}</> : (
        <div className="table-wrap" style={{ maxHeight: 300, overflow: 'auto' }}><table><thead><tr>{table.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'right mono' : ''}>{c}</td>)}</tr>)}</tbody></table></div>
      )}
    </section>
  );
}

/* ---------- Delta chip (icon + sign + named comparison; never colour alone) ---------- */
export function Delta({ cur, prev, goodUp = true, label }: { cur: number; prev: number | null | undefined; goodUp?: boolean; label: string }) {
  if (prev === null || prev === undefined) return <span className="v-delta flat">no prior data</span>;
  if (prev === 0) return <span className={`v-delta ${cur > 0 ? 'good' : 'flat'}`}>{cur > 0 ? '▲ new' : '— 0%'} <em>{label}</em></span>;
  const pct = Math.round(((cur - prev) / prev) * 100);
  const good = pct === 0 ? null : (pct > 0) === goodUp;
  return <span className={`v-delta ${good === null ? 'flat' : good ? 'good' : 'bad'}`}>{pct > 0 ? '▲' : pct < 0 ? '▼' : '—'} {pct > 0 ? '+' : ''}{pct}% <em>{label}</em></span>;
}
