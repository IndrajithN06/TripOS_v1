'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useApi } from '@/lib/api';
import { fmtDateTime, inr } from '@/lib/format';
import { Empty, ErrorBox, Loading, StatusBadge, useMe } from '@/components/ui';

const STATUSES = ['draft', 'ready_to_send', 'sent', 'negotiating', 'accepted', 'declined', 'expired', 'send_failed'];

export default function Quotes() {
  const me = useMe();
  const [search, setSearch] = useState(''), [status, setStatus] = useState(''), [page, setPage] = useState(1);
  const { data, error, loading, reload } = useApi<any>(`/quotes?search=${encodeURIComponent(search)}&status=${status}&page=${page}&pageSize=20`);
  const tz = me.agency?.timezone;
  return (
    <>
      <div className="page-head"><h1>Quotes</h1>
        <div className="row">
          <input type="search" aria-label="Search quotes" placeholder="Search quote no., customer, phone" style={{ width: 260 }} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <select aria-label="Status" style={{ width: 160 }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select>
        </div>
      </div>
      <ErrorBox e={error} retry={reload} />
      <div className="card table-wrap">
        {loading && !data ? <Loading /> : data?.items.length === 0 ? <Empty>No quotes match. Create one from a conversation in the inbox.</Empty> : (
          <table>
            <thead><tr><th>Quote</th><th>Customer</th><th>Trip</th><th>Vehicle</th><th className="right">Total</th><th>Status</th><th>Owner</th><th>Last sent</th></tr></thead>
            <tbody>{data?.items.map((q: any) => (
              <tr key={q.id} className="click" onClick={() => (location.href = `/quotes/${q.id}`)}>
                <td><Link href={`/quotes/${q.id}`}>{q.quoteNumber}</Link> <span className="badge gray">v{q.version}</span></td><td>{q.customer}</td>
                <td>{q.destination || '-'}<div className="muted small">{fmtDateTime(q.pickupAt, tz)}</div></td><td>{q.vehicleName}</td><td className="right mono">{inr(q.total)}</td>
                <td><StatusBadge s={q.status} />{['failed', 'partially_sent'].includes(q.versionStatus) && <> <StatusBadge s={q.versionStatus} /></>}{q.followUpAt && new Date(q.followUpAt) < new Date() && ['sent', 'negotiating'].includes(q.status) && <> <span className="badge amber">follow-up due</span></>}</td>
                <td>{q.owner}</td><td className="small muted">{q.lastSentAt ? fmtDateTime(q.lastSentAt, tz) : '-'}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      {data && data.total > data.pageSize && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="small muted">Page {page} of {Math.ceil(data.total / data.pageSize)} · {data.total} quotes</span>
          <button className="btn sm" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </>
  );
}
