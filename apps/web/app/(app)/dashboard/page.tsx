'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useApi } from '@/lib/api';
import { fmtDateTime, inr } from '@/lib/format';
import { Empty, ErrorBox, Loading, useMe } from '@/components/ui';

const RANGES = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']];

export default function Dashboard() {
  const me = useMe();
  const [days, setDays] = useState('30');
  const to = new Date(), from = new Date(Date.now() - Number(days) * 86400000);
  const { data, error, loading, reload } = useApi<any>(`/dashboard?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`, [days]);
  const m = data?.metrics;
  const tiles: [string, any, string][] = m ? [
    ['New enquiries', m.newEnquiries, '/inbox'], ['Open conversations', m.openConversations, '/inbox'], ['Quotes created', m.quotesCreated, '/quotes'],
    ['Awaiting customer response', m.quotesAwaitingResponse, '/quotes?status=sent'], ['Follow-ups due', m.followUpsDue, '/quotes?status=sent'], ['Accepted quotes', m.acceptedQuotes, '/quotes?status=accepted'],
    ...(m.pipelineValue !== null ? [['Pipeline value', inr(m.pipelineValue), '/quotes'] as [string, any, string]] : []),
  ] : [];
  return (
    <>
      <div className="page-head">
        <div><h1>Dashboard</h1><div className="muted small">{data?.scope === 'limited' ? 'Your quotes and conversations' : `${me.agency?.name} · all activity`}</div></div>
        <select aria-label="Date range" style={{ width: 160 }} value={days} onChange={(e) => setDays(e.target.value)}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </div>
      <ErrorBox e={error} retry={reload} />
      {loading && !data && <Loading />}
      {data && (
        <div className="stack">
          <div className="grid cols-4">{tiles.map(([l, n, href]) => <Link key={l} href={href} className="card stat" style={{ color: 'inherit' }}><div className="n mono">{n}</div><div className="l">{l}</div></Link>)}</div>
          <div className="muted small">Quotes created counts parent quotes ({m.quotesCreated}); {m.versionsCreated} version(s) were created in total. Pipeline value uses the current version of open quotes only.</div>
          {(data.alerts.failedQuoteSends > 0 || data.alerts.failedMessages > 0) && (
            <div className="banner err" role="alert"><strong>Needs attention:</strong> {data.alerts.failedQuoteSends} quote send(s) failed or partially failed, {data.alerts.failedMessages} message(s) failed. <Link href="/quotes?status=send_failed">Review</Link></div>
          )}
          {data.scope === 'full' && (
            <div className="card"><h2>Recent activity</h2>
              {data.activity.length === 0 ? <Empty>No activity yet.</Empty> : <table><tbody>{data.activity.map((a: any) => <tr key={a.id}><td>{a.action.replace(/[._]/g, ' ')}</td><td className="muted small">{a.entityType}</td><td className="right muted small">{fmtDateTime(a.createdAt, me.agency?.timezone)}</td></tr>)}</tbody></table>}
            </div>
          )}
          <div className="row"><Link className="btn primary" href="/inbox">Open inbox</Link><Link className="btn" href="/quotes">View quotes</Link></div>
        </div>
      )}
    </>
  );
}
