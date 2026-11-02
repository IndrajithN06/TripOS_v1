'use client';
import { useState } from 'react';
import { api, useApi } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtRelative, inr, isoToZoned, zonedToIso } from '@/lib/format';
import { initials } from '@/lib/inbox-view';
import { historyParts, nextStep, quoteWhat, windowView } from '@/lib/inbox-workflow';
import { canDeleteQuote } from '@/lib/quote-delete';
import { StatusBadge, useAction, useMe, useToast } from '@/components/ui';
import type { DeletableQuote } from '@/components/ConfirmDeleteQuote';

type Tab = 'customer' | 'quotes' | 'notes';

/**
 * The inbox "Customer details" slide-over: who this is, what has been quoted, and the team's private notes, in three tabs.
 * It only displays what the API reports (workflow, window, quote totals and follow-up flags are all computed on the server) and
 * uses the existing endpoints for every action. Internal notes are never sent to the customer.
 */
export function CustomerDetailsPanel({ d, onReload, onNewQuote, onEditQuote, onDeleteQuote, onClose, children }: {
  d: any; onReload: () => void; onNewQuote: () => void; onEditQuote: (quoteId: string) => void; onDeleteQuote: (q: DeletableQuote) => void; onClose: () => void; children?: React.ReactNode;
}) {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('customer');
  const tz = me.agency?.timezone;
  const quotes: any[] = d.quotes ?? [];
  const notes: any[] = d.notes ?? [];
  const TABS: [Tab, string][] = [['customer', 'Customer'], ['quotes', quotes.length ? `Quotes (${quotes.length})` : 'Quotes'], ['notes', notes.length ? `Notes (${notes.length})` : 'Notes']];

  return (
    <section className="inbox-details" aria-label="Customer details">
      <div className="details-head"><strong>Customer details</strong><button className="btn sm details-close" onClick={onClose} aria-label="Close details">✕</button></div>
      <div className="details-tabs tabs" role="tablist" aria-label="Customer details sections">
        {TABS.map(([k, label]) => <button key={k} role="tab" id={`dtab-${k}`} aria-selected={tab === k} aria-controls={`dpanel-${k}`} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      <div className="details-body" role="tabpanel" id={`dpanel-${tab}`} aria-labelledby={`dtab-${tab}`}>
        {tab === 'customer' && <CustomerTab d={d} quotes={quotes} tz={tz} onReload={onReload}>{children}</CustomerTab>}
        {tab === 'quotes' && <QuotesTab d={d} quotes={quotes} tz={tz} onReload={onReload} onNewQuote={onNewQuote} onEditQuote={onEditQuote} onDeleteQuote={onDeleteQuote} />}
        {tab === 'notes' && <NotesTab id={d.id} notes={notes} tz={tz} onReload={onReload} />}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ Customer

function CustomerTab({ d, quotes, tz, onReload, children }: { d: any; quotes: any[]; tz?: string; onReload: () => void; children?: React.ReactNode }) {
  const me = useMe(), run = useAction(), toast = useToast();
  const c = d.customer;
  const history = historyParts(d.customerHistory);
  const win = windowView({ windowOpen: d.windowOpen, windowExpiresAt: d.windowExpiresAt });
  const step = nextStep({ workflow: d.workflow, quotes });
  const showAssignment = d.salesVisibility === 'assigned'; // assignment only matters when Sales see just their own chats
  const canAssign = showAssignment && me.user.role === 'AGENCY_ADMIN';
  const users = useApi<any[]>(canAssign ? '/agency/users' : null);

  async function copyPhone() {
    try { await navigator.clipboard.writeText(c.phone); toast('Phone number copied'); }
    catch {
      const t = document.createElement('textarea'); t.value = c.phone; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); toast('Phone number copied'); } catch { toast('Could not copy. Select the number and copy it.', true); }
      t.remove();
    }
  }

  return (
    <div className="stack details-pad">
      <div className={`nextstep ${step.tone}`} data-testid="next-step"><span className="nextstep-label">Next step</span>{step.text}</div>

      <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <span className="avatar" aria-hidden="true">{initials(c.name)}</span>
        <div style={{ minWidth: 0 }}>
          <strong>{c.name}</strong>
          <div className="row" style={{ gap: 6, marginTop: 2 }}>
            <span className="mono small">{c.phone}</span>
            <button className="btn sm" onClick={copyPhone} aria-label="Copy phone number" title="Copy phone number">Copy</button>
          </div>
          {c.email && <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{c.email}</div>}
        </div>
      </div>
      <a className="btn sm" href={`/customers/${c.id}`} style={{ justifySelf: 'start' }}>Open customer profile →</a>

      <div className="kv" data-testid="window-info">
        <span className="muted small">WhatsApp window</span>
        <span className="small">
          {win.kind === 'open' && <>Free replies open{win.at && <> until <strong>{fmtDateTime(win.at, tz)}</strong></>}</>}
          {win.kind === 'closed' && <>Closed on {fmtDateTime(win.at, tz)}. Only an approved template can be sent until the customer replies.</>}
          {win.kind === 'never' && <>The customer has not messaged yet. Only an approved template can start the conversation.</>}
        </span>
      </div>

      {(history.length > 0 || c.since) && (
        <div className="kv" data-testid="customer-history">
          <span className="muted small">{history.length > 0 ? 'History' : 'Customer since'}</span>
          <span className="small">
            {history.length > 0 ? history.join(' · ') : fmtDate(c.since, tz)}
            {history.length > 0 && c.since && <span className="muted"> · customer since {fmtDate(c.since, tz)}</span>}
          </span>
        </div>
      )}

      {c.notes && (
        <div className="kv" data-testid="customer-note">
          <span className="muted small">Customer note (internal)</span>
          <span className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</span>
        </div>
      )}

      {showAssignment && (
        <div className="kv" data-testid="assignment">
          <span className="muted small">Assigned to</span>
          {canAssign ? (
            <select aria-label="Assigned to" value={d.assignedUser?.id ?? ''} onChange={(e) => run(() => api(`/inbox/conversations/${d.id}`, { method: 'PATCH', body: { assignedUserId: e.target.value || null } }), 'Assignment updated').then(onReload)}>
              <option value="">Unassigned</option>{users.data?.filter((u) => u.status === 'active').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          ) : <span className="small">{d.assignedUser?.name ?? 'Unassigned'}</span>}
          <span className="muted small">This agency lets Sales see only the chats assigned to them.</span>
        </div>
      )}

      {children}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Quotes

function QuotesTab({ d, quotes, tz, onReload, onNewQuote, onEditQuote, onDeleteQuote }: {
  d: any; quotes: any[]; tz?: string; onReload: () => void; onNewQuote: () => void; onEditQuote: (id: string) => void; onDeleteQuote: (q: DeletableQuote) => void;
}) {
  const me = useMe();
  return (
    <div className="stack details-pad">
      <div className="row between"><span className="small muted">{quotes.length === 0 ? 'No quotations in this chat yet.' : 'Quotations for this chat'}</span><button className="btn sm primary" onClick={onNewQuote}>＋ New quotation</button></div>
      {quotes.map((q) => (
        <div className="quote-card" key={q.id} data-testid="quote-card">
          <div className="row between" style={{ flexWrap: 'nowrap' }}>
            <a href={`/quotes/${q.id}`}><strong>{q.quoteNumber}</strong></a>
            <StatusBadge s={q.status} />
          </div>
          <div className="small">{quoteWhat(q)}{q.total != null && <> · <strong className="mono">{inr(q.total)}</strong></>}</div>
          <div className="small muted">Created {fmtDate(q.createdAt, tz)}{q.versionNumber > 1 && <> · version {q.versionNumber}</>}</div>
          <FollowUp q={q} tz={tz} onSaved={onReload} />
          <div className="row">
            <button className="btn sm" onClick={() => onEditQuote(q.id)}>Edit / Requote</button>
            {canDeleteQuote(me.user, q.ownerUserId) && <button className="btn sm danger" aria-label={`Delete quote ${q.quoteNumber}`} onClick={() => onDeleteQuote({ id: q.id, quoteNumber: q.quoteNumber, customer: d.customer.name, status: q.status })}>Delete</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The follow-up date of one quotation, using the existing endpoint. Saved only when the person presses Save, never on blur. */
function FollowUp({ q, tz, onSaved }: { q: any; tz?: string; onSaved: () => void }) {
  const run = useAction();
  const saved = q.followUpAt ? isoToZoned(q.followUpAt, tz) : '';
  const [value, setValue] = useState(saved);
  const dirty = value !== saved;
  const save = (iso: string | null) => run(() => api(`/quotes/${q.id}/follow-up`, { body: { followUpAt: iso } }), iso ? 'Follow-up date saved' : 'Follow-up date cleared').then(onSaved);
  return (
    <div className="followup" data-testid="follow-up">
      <div className="row" style={{ gap: 6 }}>
        <span className="small muted">Follow-up</span>
        {q.followUpAt ? <span className="small">{fmtDateTime(q.followUpAt, tz)}</span> : <span className="small muted">not set</span>}
        {q.followUpOverdue && <span className="badge red" data-testid="overdue">Overdue</span>}
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <input type="datetime-local" aria-label={`Follow-up date for ${q.quoteNumber}`} value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn sm" disabled={!dirty || !value} onClick={() => save(zonedToIso(value, tz))}>Save</button>
        {q.followUpAt && <button className="btn sm" onClick={() => { setValue(''); void save(null); }}>Clear</button>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Notes

function NotesTab({ id, notes, tz, onReload }: { id: string; notes: any[]; tz?: string; onReload: () => void }) {
  const run = useAction();
  const [text, setText] = useState('');
  const add = () => text.trim() && run(() => api(`/inbox/conversations/${id}/notes`, { body: { text } }), 'Note added').then(() => { setText(''); onReload(); });
  const newestFirst = [...notes].reverse();
  return (
    <div className="stack details-pad">
      <div className="small muted">Internal notes. They are never sent to the customer.</div>
      <div className="stack">
        <textarea rows={2} aria-label="Add note" placeholder="Add a note for your team…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void add(); }} />
        <button className="btn sm primary" style={{ justifySelf: 'start' }} disabled={!text.trim()} onClick={add}>Add note</button>
      </div>
      {notes.length === 0 && <div className="small muted">No notes yet.</div>}
      {newestFirst.map((n) => (
        <div key={n.id} className="note" data-testid="note">
          <div style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>
          <div className="muted small">{n.author} · {fmtDateTime(n.createdAt, tz)} <span title={fmtDateTime(n.createdAt, tz)}>({fmtRelative(n.createdAt)} ago)</span></div>
        </div>
      ))}
    </div>
  );
}
