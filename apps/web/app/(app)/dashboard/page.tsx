'use client';
import './dashboard.css';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useApi } from '@/lib/api';
import { inr } from '@/lib/format';
import { ChartCard, Delta, FunnelChart, HBars, Heatmap, Legend, SegmentBar, Sparkline, TrendChart, compact, wholeInr } from '@/components/charts';
import { Empty, ErrorBox, Loading, useMe } from '@/components/ui';

const RANGES: [string, string][] = [['7', '7 days'], ['30', '30 days'], ['90', '90 days']];
const STATUS_ORDER: { key: string; label: string; color: string; mark: string }[] = [
  { key: 'accepted', label: 'Accepted', color: 'var(--v-good)', mark: '✓' },
  { key: 'negotiating', label: 'Negotiating', color: 'var(--v-s2)', mark: '↔' },
  { key: 'sent', label: 'Sent, awaiting reply', color: 'var(--v-s1)', mark: '➤' },
  { key: 'draft', label: 'Draft', color: 'var(--v-neutral)', mark: '✎' },
  { key: 'declined', label: 'Declined', color: 'var(--v-critical)', mark: '✕' },
  { key: 'send_failed', label: 'Send failed', color: 'var(--v-serious)', mark: '!' },
  { key: 'expired', label: 'Expired', color: 'var(--v-axis)', mark: '⌛' },
  { key: 'ready_to_send', label: 'Ready to send', color: 'var(--v-warn)', mark: '●' },
];
const dur = (s: number | null) => (s === null ? '—' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

export default function Dashboard() {
  const me = useMe();
  const [days, setDays] = useState('30');
  const range = useMemo(() => { const to = new Date(), from = new Date(Date.now() - Number(days) * 86400000); return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`; }, [days]);
  const a = useApi<any>(`/dashboard/analytics?${range}`, [days]);
  const b = useApi<any>(`/dashboard?${range}`, [days]);
  const d = a.data, k = d?.kpis, ops = b.data;
  const vs = `vs prev ${days}d`;

  if (a.error && !d) return <><div className="page-head"><h1>Dashboard</h1></div><ErrorBox e={a.error} retry={a.reload} /></>;
  if (!d) return <><div className="page-head"><h1>Dashboard</h1></div><Loading what="Building your dashboard" /></>;

  const dates: string[] = d.series.map((s: any) => s.date);
  const col = (key: string): number[] => d.series.map((s: any) => s[key]);
  const trend = [
    { key: 'enquiries', label: 'Enquiries', color: 'var(--v-s1)', values: col('enquiries') },
    { key: 'quotesSent', label: 'Quotes sent', color: 'var(--v-s2)', values: col('quotesSent') },
    { key: 'accepted', label: 'Accepted', color: 'var(--v-s3)', values: col('accepted') },
  ];
  const statusParts = STATUS_ORDER.map((s) => ({ ...s, value: d.statusBreakdown.find((x: any) => x.status === s.key)?.count ?? 0 }));
  const pipe = k.pipelineBreakdown;
  const pipeTotal = pipe ? Number(pipe.sent) + Number(pipe.negotiating) : 0;
  const empty = k.enquiries === 0 && k.quotesCreated === 0;

  return (
    <div className={`viz ${a.loading || b.loading ? 'busy' : ''}`}>
      <div className="page-head">
        <div><h1>Dashboard</h1><div className="muted small">{d.scope === 'limited' ? 'Your quotes and conversations' : `${me.agency?.name} · all activity`} · times in {d.timezone.replace('_', ' ')}</div></div>
        <div className="seg-ctl" role="group" aria-label="Date range">{RANGES.map(([v, l]) => <button key={v} aria-pressed={days === v} onClick={() => setDays(v)}>Last {l}</button>)}</div>
      </div>

      {(ops?.alerts.failedQuoteSends > 0 || ops?.alerts.failedMessages > 0) && (
        <div className="banner err row" role="alert">
          <span>⚠ <strong>Needs attention:</strong></span>
          {ops.alerts.failedQuoteSends > 0 && <span>{ops.alerts.failedQuoteSends} quote send(s) failed or only partly delivered · <Link href="/quotes">Review quotes</Link></span>}
          {ops.alerts.failedMessages > 0 && <span>{ops.alerts.failedMessages} message(s) not delivered and not yet followed up · <Link href="/inbox">Open inbox</Link></span>}
        </div>
      )}
      {empty && <div className="card"><Empty>No activity in this period yet. Receive an enquiry in the Inbox (use the simulator) or run <code>npm run db:seed:history -w @tripos/api</code> for demo data.</Empty></div>}

      <div className="v-top">
        <section className="card v-hero" aria-label="Headline figure">
          {k.pipelineValue !== null ? (
            <>
              <div><div className="eyebrow">Open pipeline</div><div className="big">{wholeInr(k.pipelineValue)}</div>
                <div className="muted small">{ops?.metrics.quotesAwaitingResponse ?? 0} quote(s) awaiting the customer · current versions only</div></div>
              <div>
                <div className="v-hero-bar" role="img" aria-label={`Pipeline split: sent ${inr(pipe.sent)}, negotiating ${inr(pipe.negotiating)}`}>
                  <div style={{ flexGrow: Number(pipe.sent) || 0.001, background: 'var(--v-s1)' }} /><div style={{ flexGrow: Number(pipe.negotiating) || 0.001, background: 'var(--v-s2)' }} />
                </div>
                <div className="v-hero-legend" style={{ marginTop: 8 }}>
                  <span><span className="v-swatch" style={{ background: 'var(--v-s1)' }} />Sent <strong style={{ color: 'var(--ink)' }}>{wholeInr(pipe.sent)}</strong></span>
                  <span><span className="v-swatch" style={{ background: 'var(--v-s2)' }} />Negotiating <strong style={{ color: 'var(--ink)' }}>{wholeInr(pipe.negotiating)}</strong></span>
                  {pipeTotal === 0 && <span>Nothing open right now</span>}
                </div>
              </div>
            </>
          ) : (
            <><div><div className="eyebrow">Accepted value (your quotes)</div><div className="big">{wholeInr(k.acceptedValue)}</div></div><div className="muted small">Pipeline totals are visible to agency admins.</div></>
          )}
          <Sparkline values={col('quotesCreated')} label="Quotes created per day" />
        </section>

        <div className="v-tiles">
          <Tile label="Enquiries" value={k.enquiries} sub="new conversations" spark={col('enquiries')} delta={<Delta cur={k.enquiries} prev={k.previousEnquiries} label={vs} />} href="/inbox" color="var(--v-s1)" />
          <Tile label="Quotes created" value={k.quotesCreated} sub={`${ops?.metrics.versionsCreated ?? 0} versions in total`} spark={col('quotesCreated')} delta={<Delta cur={k.quotesCreated} prev={k.previousQuotesCreated} label={vs} />} href="/quotes" color="var(--v-s2)" />
          <Tile label="Accepted" value={k.accepted} sub={`${wholeInr(k.acceptedValue)} value`} spark={col('accepted')} delta={<Delta cur={k.accepted} prev={k.previousAccepted} label={vs} />} href="/quotes?status=accepted" color="var(--v-s3)" />
          <Tile label="Conversion" value={k.conversionRate === null ? '—' : `${k.conversionRate}%`} sub="accepted ÷ sent quotes" />
          <Tile label="Avg quote value" value={k.avgQuoteValue ? wholeInr(k.avgQuoteValue) : '—'} sub="current versions" delta={k.avgQuoteValue && k.previousAvgQuoteValue ? <Delta cur={Number(k.avgQuoteValue)} prev={Number(k.previousAvgQuoteValue)} label={vs} /> : undefined} />
          <Tile label="First response" value={dur(k.medianFirstResponseSeconds)} sub="median time to first reply" />
          <Tile label="Delivery success" value={k.deliverySuccessRate === null ? '—' : `${k.deliverySuccessRate}%`} sub="quote items delivered" />
          <Tile label="Follow-ups due" value={ops?.metrics.followUpsDue ?? 0} sub="sent quotes needing a nudge" href="/quotes?status=sent" />
        </div>
      </div>

      <div className="v-row2">
        <ChartCard title="Activity trend" subtitle="Enquiries, quotes sent and accepted per day"
          legend={<Legend items={trend.map((s) => ({ label: s.label, color: s.color }))} />}
          table={{ head: ['Date', 'Enquiries', 'Quotes sent', 'Accepted'], rows: d.series.map((s: any) => [s.date, s.enquiries, s.quotesSent, s.accepted]) }}>
          <TrendChart dates={dates} series={trend} />
        </ChartCard>
        <ChartCard title="Enquiry to acceptance" subtitle="Quotes created in this period, followed through to the outcome" table={{ head: ['Stage', 'Count'], rows: d.funnel.map((f: any) => [f.stage, f.value]) }}>
          <FunnelChart stages={d.funnel} />
        </ChartCard>
      </div>

      <div className="v-row3">
        <ChartCard title="Quote status" subtitle="Current status of quotes created in this period">
          <SegmentBar parts={statusParts} />
        </ChartCard>
        <ChartCard title="Top vehicles" subtitle="By quotes created · total quoted value" table={{ head: ['Vehicle', 'Quotes', 'Quoted value'], rows: d.topVehicles.map((v: any) => [v.name, v.quotes, wholeInr(v.value)]) }}>
          {d.topVehicles.length === 0 ? <Empty>No quotes yet.</Empty> : <HBars rows={d.topVehicles.map((v: any) => ({ label: v.name, value: v.quotes, display: `${v.quotes}`, sub: `${wholeInr(v.value)} quoted` }))} />}
        </ChartCard>
        <ChartCard title="When customers write" subtitle="Inbound messages by weekday and hour">
          <Heatmap data={d.heatmap} />
        </ChartCard>
      </div>

      <div className="row"><Link className="btn primary" href="/inbox">Open inbox</Link><Link className="btn" href="/quotes">All quotes</Link><span className="muted small">Counts of quotes use parent quotes; pipeline uses the current version of open quotes only.</span></div>
    </div>
  );
}

function Tile({ label, value, sub, spark, delta, href, color }: { label: string; value: React.ReactNode; sub?: string; spark?: number[]; delta?: React.ReactNode; href?: string; color?: string }) {
  const body = (
    <>
      <div className="lbl">{label}</div>
      <div className="val mono" style={{ fontVariantNumeric: 'normal' }}>{typeof value === 'number' ? compact(value) : value}</div>
      {delta}
      {sub && <div className="sub">{sub}</div>}
      {spark && <Sparkline values={spark} color={color} label={`${label} per day`} />}
    </>
  );
  return href ? <Link href={href} className="card v-tile" style={{ color: 'inherit' }}>{body}</Link> : <div className="card v-tile">{body}</div>;
}
