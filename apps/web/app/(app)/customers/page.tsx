'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, useApi } from '@/lib/api';
import { defaultPhonePrefix, displayPhone, validateCustomerForm, CustomerFormErrors } from '@/lib/customers';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { Empty, ErrorBox, Field, Loading, Modal, errMsg, useMe, useToast } from '@/components/ui';

export default function Customers() {
  const me = useMe();
  const [search, setSearch] = useState(''), [page, setPage] = useState(1), [creating, setCreating] = useState(false);
  const { data, error, loading, reload } = useApi<any>(`/customers?search=${encodeURIComponent(search)}&page=${page}&pageSize=20`);
  const tz = me.agency?.timezone;
  return (
    <>
      <div className="page-head"><h1>Customers</h1>
        <div className="row">
          <input type="search" aria-label="Search customers" placeholder="Search name, phone or email" style={{ width: 260 }} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <button className="btn primary" onClick={() => setCreating(true)}>＋ New customer</button>
        </div>
      </div>
      <ErrorBox e={error} retry={reload} />
      <div className="card table-wrap">
        {loading && !data ? <Loading /> : data?.items.length === 0 ? <Empty>{search ? 'No customers match your search.' : 'No customers yet. Customers appear when someone messages you on WhatsApp, or add one yourself.'}</Empty> : (
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th className="right">Chats</th><th className="right">Quotes</th><th>Last activity</th><th>Added</th></tr></thead>
            <tbody>{data?.items.map((c: any) => (
              <tr key={c.id} className="click" onClick={() => (location.href = `/customers/${c.id}`)}>
                <td><Link href={`/customers/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.name}</Link></td>
                <td className="mono">{displayPhone(c.phone)}</td><td>{c.email ?? <span className="muted">-</span>}</td>
                <td className="right mono">{c.conversations}</td><td className="right mono">{c.quotes}</td>
                <td className="small muted">{c.lastActivityAt ? fmtRelative(c.lastActivityAt) : '-'}</td><td className="small muted">{fmtDateTime(c.createdAt, tz)}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      {data && data.total > data.pageSize && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="small muted">Page {page} of {Math.ceil(data.total / data.pageSize)} · {data.total} customers</span>
          <button className="btn sm" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
      {creating && <NewCustomer onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); reload(); location.href = `/customers/${id}`; }} />}
    </>
  );
}

function NewCustomer({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const me = useMe(), toast = useToast();
  const [f, setF] = useState({ name: '', phone: defaultPhonePrefix(me.agency?.timezone), email: '' }), [notes, setNotes] = useState('');
  const [errs, setErrs] = useState<CustomerFormErrors>({}), [busy, setBusy] = useState(false);

  async function submit() {
    const e = validateCustomerForm(f);
    setErrs(e);
    if (Object.keys(e).length || busy) return;
    setBusy(true);
    try {
      const c = await api('/customers', { body: { name: f.name.trim(), phone: f.phone, ...(f.email.trim() ? { email: f.email.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) } });
      toast(`${c.name} added`); onCreated(c.id);
    } catch (err) { toast(errMsg(err), true); setBusy(false); }
  }

  return (
    <Modal title="New customer" narrow onClose={busy ? () => undefined : onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Name"><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-invalid={!!errs.name} />{errs.name && <span className="small" style={{ color: 'var(--red)' }}>{errs.name}</span>}</Field>
        <Field label="WhatsApp / phone number (with country code)"><input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+91 98765 43210" aria-invalid={!!errs.phone} />{errs.phone && <span className="small" style={{ color: 'var(--red)' }}>{errs.phone}</span>}</Field>
        <Field label="Email (optional)"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-invalid={!!errs.email} />{errs.email && <span className="small" style={{ color: 'var(--red)' }}>{errs.email}</span>}</Field>
        <Field label="Notes (optional, internal)"><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
        <div className="small muted">If this person already messaged you on WhatsApp, they are already in the list: the same number is never added twice.</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Add customer'}</button>
        </div>
      </form>
    </Modal>
  );
}
