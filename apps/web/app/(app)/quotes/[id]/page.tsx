'use client';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, useApi } from '@/lib/api';
import { fmtDateTime, inr, isoToZoned, zonedToIso } from '@/lib/format';
import { ErrorBox, Loading, Modal, StatusBadge, useAction, useMe } from '@/components/ui';
import { QuoteBuilder } from '@/components/QuoteBuilder';
import { QuotePreview } from '@/components/QuotePreview';
import { SendQuoteModal } from '@/components/SendQuoteModal';

export default function QuoteDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe(), run = useAction(), router = useRouter(), tz = me.agency?.timezone;
  const { data: q, error, reload } = useApi<any>(`/quotes/${id}`);
  const [edit, setEdit] = useState(false), [preview, setPreview] = useState<any>(null), [diff, setDiff] = useState<any>(null), [sendV, setSendV] = useState<number | null>(null);
  if (error) return <ErrorBox e={error} retry={reload} />;
  if (!q) return <Loading />;
  const cur = q.versions.find((v: any) => v.id === q.currentVersionId);
  const act = (fn: () => Promise<unknown>, ok: string) => run(fn, ok).then(reload);
  const closed = ['accepted', 'declined'].includes(q.status);

  return (
    <>
      <div className="page-head">
        <div>
          <a href="/quotes" className="small">&larr; Quotes</a>
          <div className="row"><h1>{q.quoteNumber}</h1><StatusBadge s={q.status} /><span className="badge">current v{cur.versionNumber}</span></div>
          <div className="muted small">{q.customer.name} · {q.customer.phone}{q.conversationId && <> · <a href="/inbox">Open chat</a></>}</div>
        </div>
        <div className="row">
          {!closed && !cur.immutable && <button className="btn blue" onClick={() => setSendV(cur.versionNumber)}>Send Quotation on WhatsApp</button>}
          <button className="btn primary" onClick={() => setEdit(true)}>{cur.immutable ? 'Edit / Requote' : 'Edit draft'}</button>
          <button className="btn" onClick={() => act(async () => { const d = await api(`/quotes/${id}/duplicate`, { body: {} }); router.push(`/quotes/${d.id}`); }, 'Quote duplicated')}>Duplicate</button>
          <a className="btn" target="_blank" rel="noreferrer" href={`/api/quotes/${id}/versions/${cur.versionNumber}/pdf`}>Open PDF</a>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card stack">
          <h2>Status & follow-up</h2>
          <div className="row">
            {q.status === 'sent' && <button className="btn sm" onClick={() => act(() => api(`/quotes/${id}/status`, { body: { status: 'negotiating' } }), 'Marked negotiating')}>Customer is negotiating</button>}
            {['sent', 'negotiating', 'expired'].includes(q.status) && <button className="btn sm primary" onClick={() => act(() => api(`/quotes/${id}/status`, { body: { status: 'accepted' } }), 'Marked accepted')}>Mark accepted</button>}
            {['sent', 'negotiating', 'expired'].includes(q.status) && <button className="btn sm danger" onClick={() => act(() => api(`/quotes/${id}/status`, { body: { status: 'declined' } }), 'Marked declined')}>Mark declined</button>}
            {q.status === 'declined' && <button className="btn sm" onClick={() => act(() => api(`/quotes/${id}/status`, { body: { status: 'negotiating' } }), 'Re-opened')}>Re-open</button>}
          </div>
          <div className="small muted">A WhatsApp “read” receipt never marks a quote accepted. Acceptance is always a manual decision.</div>
          <label>Follow-up date<input type="datetime-local" disabled={closed} defaultValue={isoToZoned(q.followUpAt, tz)} onBlur={(e) => act(() => api(`/quotes/${id}/follow-up`, { body: { followUpAt: e.target.value ? zonedToIso(e.target.value, tz) : null } }), 'Follow-up saved')} /></label>
          <div className="small muted">Valid until {fmtDateTime(q.expiryAt, tz)}</div>
        </div>

        <div className="card stack">
          <h2>Current version v{cur.versionNumber}</h2>
          <table className="lines"><tbody>
            {cur.lines.map((l: any, i: number) => <tr key={i}><td>{l.label}</td><td className="right mono">{inr(l.amount)}</td></tr>)}
            {Number(cur.discount) > 0 && <tr><td className="muted">Discount</td><td className="right mono">- {inr(cur.discount)}</td></tr>}
            {Number(cur.tax) > 0 && <tr><td className="muted">Tax</td><td className="right mono">{inr(cur.tax)}</td></tr>}
            <tr className="total"><td>Total</td><td className="right mono">{inr(cur.total)}</td></tr>
          </tbody></table>
          <div className="small muted">{cur.vehicleName} · {cur.imageAssetIds.length} photo(s) · rate card snapshotted {fmtDateTime(cur.createdAt, tz)}</div>
        </div>
      </div>

      <div className="card stack" style={{ marginTop: 14 }}>
        <h2>Version history</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Version</th><th>Created</th><th className="right">Total</th><th>Delivery</th><th /></tr></thead>
          <tbody>{[...q.versions].reverse().map((v: any, i: number, arr: any[]) => (
            <tr key={v.id}>
              <td>v{v.versionNumber} {v.immutable && <span className="badge gray" title="Sent versions are immutable">sent · locked</span>}</td><td>{fmtDateTime(v.createdAt, tz)}</td><td className="right mono">{inr(v.total)}</td>
              <td>
                <StatusBadge s={v.status} />
                {v.sendAttempts.length > 0 && <div className="small muted">{v.sendAttempts.map((a: any) => `${a.kind === 'template' ? 'whatsapp template' : a.kind}:${a.status}`).join(' · ')}</div>}
                {v.sendAttempts.filter((a: any) => a.lastError).slice(0, 1).map((a: any) => <div key={a.id} className="small" style={{ color: 'var(--red)' }}>{a.lastError}</div>)}
              </td>
              <td><div className="row">
                <button className="btn sm" onClick={async () => setPreview(await api(`/quotes/${id}/versions/${v.versionNumber}/preview`))}>Preview</button>
                <a className="btn sm" target="_blank" rel="noreferrer" href={`/api/quotes/${id}/versions/${v.versionNumber}/pdf`}>PDF</a>
                {['partially_sent', 'failed'].includes(v.status) && <button className="btn sm blue" onClick={() => act(() => api(`/quotes/${id}/versions/${v.versionNumber}/retry`, { body: {} }), 'Retry finished')}>Retry failed items</button>}
                {arr[i + 1] && <button className="btn sm" onClick={async () => setDiff(await api(`/quotes/${id}/diff?from=${arr[i + 1].versionNumber}&to=${v.versionNumber}`))}>Compare v{arr[i + 1].versionNumber} &rarr; v{v.versionNumber}</button>}
              </div></td>
            </tr>))}</tbody>
        </table></div>
      </div>

      {sendV !== null && <SendQuoteModal quoteId={id} versionNumber={sendV} onClose={() => setSendV(null)} onSent={() => void reload()} />}
      {preview && <Modal title={`Preview · ${q.quoteNumber} v${preview.versionNumber}`} onClose={() => setPreview(null)}><QuotePreview p={preview} /></Modal>}
      {diff && (
        <Modal title="Changes between versions" narrow onClose={() => setDiff(null)}>
          <div className="stack">
            <div className="row between"><span>Before</span><strong className="mono">{inr(diff.totalBefore)}</strong></div>
            <div className="row between"><span>After</span><strong className="mono">{inr(diff.totalAfter)}</strong></div>
            <div className={`banner ${Number(diff.totalDelta) <= 0 ? 'ok' : 'warn'}`}>Change: <strong className="mono">{Number(diff.totalDelta) > 0 ? '+' : ''}{inr(diff.totalDelta)}</strong></div>
            {diff.changedLines.length === 0 ? <div className="muted small">No line items changed.</div> : <table><tbody>{diff.changedLines.map((l: any, i: number) => <tr key={i}><td>{l.label}</td><td className="right mono small">{l.before ? inr(l.before) : '-'} &rarr; {l.after ? inr(l.after) : '-'}</td></tr>)}</tbody></table>}
          </div>
        </Modal>
      )}
      {edit && <QuoteBuilder quoteId={id} onClose={() => { setEdit(false); reload(); }} onChanged={reload} />}
    </>
  );
}
