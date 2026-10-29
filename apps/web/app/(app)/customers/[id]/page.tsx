'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, useApi } from '@/lib/api';
import { displayPhone, validateCustomerForm, CustomerFormErrors } from '@/lib/customers';
import { fmtDateTime, fmtRelative, inr } from '@/lib/format';
import { Empty, ErrorBox, Field, Loading, Modal, StatusBadge, errMsg, useMe, useToast } from '@/components/ui';
import { QuoteBuilder } from '@/components/QuoteBuilder';

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe(), tz = me.agency?.timezone;
  const { data: c, error, reload } = useApi<any>(`/customers/${id}`);
  const [editing, setEditing] = useState(false), [quoting, setQuoting] = useState(false);
  if (error) return <><a href="/customers" className="small">&larr; Customers</a><ErrorBox e={error} retry={reload} /></>;
  if (!c) return <Loading />;

  return (
    <>
      <div className="page-head">
        <div>
          <a href="/customers" className="small">&larr; Customers</a>
          <h1>{c.name}</h1>
          <div className="muted small"><span className="mono">{displayPhone(c.phone)}</span>{c.email && <> · {c.email}</>} · added {fmtDateTime(c.createdAt, tz)}</div>
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => setQuoting(true)}>＋ New quote</button>
          <button className="btn" onClick={() => setEditing(true)}>Edit</button>
          {c.conversations.length > 0 && <a className="btn" href="/inbox">Open WhatsApp inbox</a>}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card stack">
          <h2>Details</h2>
          <div className="small"><span className="muted">Phone (WhatsApp)</span><br /><span className="mono">{displayPhone(c.phone)}</span> <span className="muted">· cannot be changed here</span></div>
          <div className="small"><span className="muted">Email</span><br />{c.email ?? <span className="muted">Not set</span>}</div>
          <div className="small"><span className="muted">Internal notes (never sent to the customer)</span><br />{c.notes ? <span style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</span> : <span className="muted">None</span>}</div>
        </div>

        <div className="card stack">
          <h2>WhatsApp conversations</h2>
          {c.conversations.length === 0 ? <div className="small muted">No WhatsApp conversation yet. You can still create a quote for this customer.</div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Status</th><th>Last message</th><th>Assigned to</th><th className="right">Unread</th></tr></thead>
              <tbody>{c.conversations.map((v: any) => (
                <tr key={v.id}><td><StatusBadge s={v.status} /></td><td className="small muted">{fmtRelative(v.lastMessageAt)} ago</td><td className="small">{v.assignedUser?.name ?? <span className="muted">Unassigned</span>}</td><td className="right mono">{v.unreadCount}</td></tr>))}</tbody>
            </table></div>
          )}
        </div>
      </div>

      <div className="card stack" style={{ marginTop: 14 }}>
        <div className="row between"><h2 style={{ margin: 0 }}>Quotes</h2><button className="btn sm" onClick={() => setQuoting(true)}>＋ New quote</button></div>
        {c.quotes.length === 0 ? <Empty>No quotes for this customer yet.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Quote</th><th>Vehicle</th><th className="right">Total</th><th>Status</th><th>Follow-up</th><th>Created</th></tr></thead>
            <tbody>{c.quotes.map((q: any) => (
              <tr key={q.id} className="click" onClick={() => (location.href = `/quotes/${q.id}`)}>
                <td><a href={`/quotes/${q.id}`} onClick={(e) => e.stopPropagation()}>{q.quoteNumber}</a> {q.version && <span className="badge gray">v{q.version}</span>}</td>
                <td>{q.vehicleName ?? '-'}</td><td className="right mono">{q.total ? inr(q.total) : '-'}</td><td><StatusBadge s={q.status} /></td>
                <td className="small muted">{q.followUpAt ? fmtDateTime(q.followUpAt, tz) : '-'}</td><td className="small muted">{fmtDateTime(q.createdAt, tz)}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </div>

      {editing && <EditCustomer customer={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      {quoting && <QuoteBuilder customerId={c.id} conversationId={c.conversations[0]?.id} onClose={() => { setQuoting(false); reload(); }} onChanged={reload} />}
    </>
  );
}

function EditCustomer({ customer, onClose, onSaved }: { customer: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: customer.name as string, phone: customer.phone as string, email: (customer.email ?? '') as string }), [notes, setNotes] = useState((customer.notes ?? '') as string);
  const [errs, setErrs] = useState<CustomerFormErrors>({}), [busy, setBusy] = useState(false);

  async function submit() {
    const e = validateCustomerForm(f, false);
    setErrs(e);
    if (Object.keys(e).length || busy) return;
    setBusy(true);
    try {
      await api(`/customers/${customer.id}`, { method: 'PATCH', body: { name: f.name.trim(), email: f.email.trim() || null, notes: notes.trim() || null } });
      toast('Customer updated'); onSaved();
    } catch (err) { toast(errMsg(err), true); setBusy(false); }
  }

  return (
    <Modal title={`Edit ${customer.name}`} narrow onClose={busy ? () => undefined : onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Name"><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-invalid={!!errs.name} />{errs.name && <span className="small" style={{ color: 'var(--red)' }}>{errs.name}</span>}</Field>
        <Field label="Phone (cannot be changed)"><input value={displayPhone(customer.phone)} disabled readOnly /></Field>
        <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-invalid={!!errs.email} />{errs.email && <span className="small" style={{ color: 'var(--red)' }}>{errs.email}</span>}</Field>
        <Field label="Internal notes"><textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
