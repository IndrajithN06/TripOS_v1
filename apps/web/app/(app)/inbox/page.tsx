'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, useApi } from '@/lib/api';
import { fmtRelative, fmtTime, inr } from '@/lib/format';
import { Empty, ErrorBox, Loading, SimTag, StatusBadge, errMsg, useAction, useMe } from '@/components/ui';
import { QuoteBuilder } from '@/components/QuoteBuilder';

const POLL_MS = 4000; // V1 uses short polling instead of SSE/WebSockets (see docs/DECISIONS_AND_ASSUMPTIONS.md)

export default function InboxPage() {
  const me = useMe();
  const run = useAction();
  const [filter, setFilter] = useState('all'), [search, setSearch] = useState(''), [sel, setSel] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), POLL_MS); return () => clearInterval(t); }, []);
  const list = useApi<any>(`/inbox/conversations?filter=${filter}&search=${encodeURIComponent(search)}`, [tick]);
  useEffect(() => { if (!sel && list.data?.items?.length) setSel(list.data.items[0].id); }, [list.data, sel]);

  return (
    <div className="inbox">
      <section>
        <div className="panel-sec stack">
          <input type="search" aria-label="Search conversations" placeholder="Search name, phone or message" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select aria-label="Filter conversations" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All conversations</option><option value="unread">Unread</option><option value="mine">Assigned to me</option><option value="unassigned">Unassigned</option><option value="open">Open</option><option value="closed">Closed</option><option value="quoted">With a quote</option>
          </select>
        </div>
        <div className="conv-list">
          {list.error && <ErrorBox e={list.error} retry={list.reload} />}
          {!list.data && list.loading && <Loading what="Loading conversations" />}
          {list.data?.items.length === 0 && <Empty>No conversations yet.{me.environment.whatsappSimulated && ' Use the simulator panel on the right to receive a test enquiry.'}</Empty>}
          {list.data?.items.map((c: any) => (
            <div key={c.id} className={`conv ${sel === c.id ? 'sel' : ''}`} onClick={() => setSel(c.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(c.id)}>
              <div className="row between"><strong>{c.customer?.name}</strong><span className="small muted">{fmtRelative(c.lastMessageAt)}</span></div>
              <div className="row between"><span className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 190 }}>{c.preview}</span>{c.unreadCount > 0 && <span className="unread">{c.unreadCount}</span>}</div>
              <div className="row small">{c.lastQuote && <StatusBadge s={c.lastQuote.status} />}{c.assignedUser && <span className="muted">→ {c.assignedUser.name}</span>}</div>
            </div>
          ))}
        </div>
      </section>
      {sel ? <Conversation key={sel} id={sel} tick={tick} onChanged={list.reload} /> : <section><Empty>Select a conversation</Empty></section>}
    </div>
  );
}

function Conversation({ id, tick, onChanged }: { id: string; tick: number; onChanged: () => void }) {
  const me = useMe(), run = useAction();
  const detail = useApi<any>(`/inbox/conversations/${id}`, [tick]);
  const msgs = useApi<any>(`/inbox/conversations/${id}/messages?limit=100`, [tick]);
  const templates = useApi<any[]>('/agency/whatsapp/templates');
  const users = useApi<any[]>(me.user.role === 'AGENCY_ADMIN' ? '/agency/users' : null);
  const [text, setText] = useState(''), [builder, setBuilder] = useState<{ quoteId?: string; prefill?: any } | null>(null), [sending, setSending] = useState(false);
  const [note, setNote] = useState(''), [ai, setAi] = useState<any>(null), [aiBusy, setAiBusy] = useState(false), [aiErr, setAiErr] = useState('');
  const [tpl, setTpl] = useState(''), [vars, setVars] = useState<string[]>([]);
  const bottom = useRef<HTMLDivElement>(null), lastCount = useRef(0);

  useEffect(() => { void api(`/inbox/conversations/${id}/read`, { method: 'POST' }).then(onChanged).catch(() => undefined); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const n = msgs.data?.items.length ?? 0; if (n !== lastCount.current) { lastCount.current = n; bottom.current?.scrollIntoView({ block: 'end' }); } }, [msgs.data]);

  const d = detail.data;
  const reload = () => { void detail.reload(); void msgs.reload(); onChanged(); };

  async function sendText() {
    if (!text.trim()) return;
    setSending(true);
    const r = await run(() => api(`/inbox/conversations/${id}/messages`, { body: { type: 'text', text, idempotencyKey: crypto.randomUUID() } }));
    setSending(false);
    if (r?.ok) setText('');
    else if (r && !r.ok) setText(text); // keep the draft so nothing is lost; failed bubble shows retry
    reload();
  }
  async function sendTemplate() {
    const t = templates.data?.find((x) => x.id === tpl); if (!t) return;
    const r = await run(() => api(`/inbox/conversations/${id}/messages`, { body: { type: 'template', templateId: t.id, variables: vars, idempotencyKey: crypto.randomUUID() } }), 'Template sent');
    if (r) { setTpl(''); setVars([]); reload(); }
  }
  async function runAi(feature: string, body: object = {}) {
    setAiBusy(true); setAiErr('');
    try { setAi(await api(`/inbox/conversations/${id}/ai/${feature}`, { body })); if (feature === 'summary') void detail.reload(); }
    catch (e) { setAi(null); setAiErr(errMsg(e)); }
    setAiBusy(false);
  }
  const extractToPrefill = (o: any) => {
    const f = o.fields;
    return { pickupLocation: f.pickupLocation ?? '', destinations: f.destination ?? '', passengers: f.passengers ? String(f.passengers) : '4', days: f.days ? String(f.days) : '1', tripType: f.tripType === 'local' ? 'local_8h_80km' : 'outstation' };
  };

  if (detail.error) return <section><ErrorBox e={detail.error} retry={detail.reload} /></section>;
  if (!d) return <section><Loading /></section>;
  const selectedTpl = templates.data?.find((x) => x.id === tpl);

  return (
    <>
      <section>
        <div className="panel-sec row between">
          <div><strong>{d.customer.name}</strong> <span className="muted small">{d.customer.phone}</span></div>
          <div className="row">
            <span className={`badge ${d.windowOpen ? 'green' : 'amber'}`} title="Free-form replies are allowed for 24h after the customer's last message">{d.windowOpen ? '24h window open' : 'Window closed — template only'}</span>
            <button className="btn primary sm" onClick={() => setBuilder({})}>＋ New quote</button>
          </div>
        </div>
        <div className="thread" aria-live="polite">
          {msgs.data?.items.length === 0 && <Empty>No messages yet.</Empty>}
          {msgs.data?.items.map((m: any) => (
            <div key={m.id} className={`bubble ${m.direction === 'outbound' ? 'out' : ''}`}>
              {m.media?.mimeType?.startsWith('image/') && <a href={m.media.url} target="_blank" rel="noreferrer"><img src={m.media.url} alt="Attachment" /></a>}
              {m.media && !m.media.mimeType.startsWith('image/') && <a href={m.media.url} target="_blank" rel="noreferrer">📎 {m.type === 'document' ? 'Document' : 'Attachment'} ({m.media.mimeType})</a>}
              {m.type === 'template' && <div className="small muted">Template</div>}
              {m.text}
              {m.quote && <div className="small"><a href={`/quotes/${m.quote.quoteId}`}>{m.quote.quoteNumber} v{m.quote.version}</a></div>}
              <div className="meta">
                {fmtTime(m.createdAt, me.agency?.timezone)}{m.simulated && <SimTag />}
                {m.direction === 'outbound' && <StatusBadge s={m.status} />}
                {m.simulated && m.direction === 'outbound' && m.providerMessageId && ['submitted', 'sent', 'delivered'].includes(m.status) && (['delivered', 'read'] as const).map((s) => <button key={s} className="btn sm" title="Simulate provider status webhook" onClick={() => run(() => api('/dev/simulator/status', { body: { providerMessageId: m.providerMessageId, status: s } })).then(reload)}>sim {s}</button>)}
                {m.status === 'failed' && <span style={{ color: 'var(--red)' }}>{m.errorMessage}</span>}
                {m.status === 'failed' && m.type === 'text' && <button className="btn sm" onClick={() => run(() => api(`/inbox/conversations/${id}/messages/${m.id}/retry`, { body: {} }), 'Retried').then(reload)}>Retry</button>}
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <div className="composer">
          {ai?.output?.replies && <div className="chips" aria-label="Suggested replies (drafts)">{ai.output.replies.map((r: string, i: number) => <button key={i} className="chip" onClick={() => setText(r)} title="Click to edit before sending">💡 {r.slice(0, 70)}…</button>)}</div>}
          {ai?.output?.reply && <div className="chips"><button className="chip" onClick={() => setText(ai.output.reply)}>💡 Use suggested reply</button></div>}
          <textarea aria-label="Message" placeholder={d.windowOpen ? 'Type a message…' : 'Window closed: choose an approved template below'} disabled={!d.windowOpen} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void sendText(); }} />
          <div className="row between">
            <div className="row">
              <select aria-label="Template" value={tpl} onChange={(e) => { setTpl(e.target.value); const t = templates.data?.find((x) => x.id === e.target.value); setVars(new Array(t?.variableSchema.length ?? 0).fill('')); }} style={{ width: 200 }}>
                <option value="">Use template…</option>{templates.data?.map((t) => <option key={t.id} value={t.id} disabled={t.providerStatus !== 'approved'}>{t.name} ({t.providerStatus})</option>)}
              </select>
              <button className="btn sm" onClick={() => runAi('reply-suggestions')} disabled={aiBusy}>💡 Suggest replies</button>
            </div>
            <button className="btn primary" disabled={sending || !text.trim() || !d.windowOpen} onClick={sendText}>{sending ? 'Sending…' : 'Send'}</button>
          </div>
          {selectedTpl && (
            <div className="card stack">
              <div className="small muted">{selectedTpl.body}</div>
              {selectedTpl.variableSchema.map((v: string, i: number) => <input key={i} placeholder={`{{${i + 1}}} ${v}`} value={vars[i] ?? ''} onChange={(e) => setVars(vars.map((x, j) => (j === i ? e.target.value : x)))} />)}
              <button className="btn blue" onClick={sendTemplate}>Send template</button>
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="panel-sec stack">
          <h3>Customer</h3>
          <div>{d.customer.name}<br /><span className="muted small">{d.customer.phone}{d.customer.email ? ` · ${d.customer.email}` : ''}</span></div>
          {me.user.role === 'AGENCY_ADMIN' ? (
            <label>Assigned to<select value={d.assignedUser?.id ?? ''} onChange={(e) => run(() => api(`/inbox/conversations/${id}`, { method: 'PATCH', body: { assignedUserId: e.target.value || null } }), 'Assignment updated').then(reload)}>
              <option value="">Unassigned</option>{users.data?.filter((u) => u.status === 'active').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          ) : <div className="small">Assigned to: {d.assignedUser?.name ?? 'Unassigned'} {!d.assignedUser && <button className="btn sm" onClick={() => run(() => api(`/inbox/conversations/${id}`, { method: 'PATCH', body: { assignedUserId: me.user.id } }), 'Assigned to you').then(reload)}>Take</button>}</div>}
          <label>Status<select value={d.status} onChange={(e) => run(() => api(`/inbox/conversations/${id}`, { method: 'PATCH', body: { status: e.target.value } })).then(reload)}><option value="open">Open</option><option value="pending">Pending</option><option value="closed">Closed</option></select></label>
        </div>

        <div className="panel-sec stack">
          <div className="row between"><h3 style={{ margin: 0 }}>Quotes</h3><button className="btn sm" onClick={() => setBuilder({})}>＋ New</button></div>
          {d.quotes.length === 0 && <div className="small muted">No quotes in this chat yet.</div>}
          {d.quotes.map((q: any) => (
            <div className="row between" key={q.id}><a href={`/quotes/${q.id}`}>{q.quoteNumber}</a><span className="row"><StatusBadge s={q.status} /><button className="btn sm" onClick={() => setBuilder({ quoteId: q.id })}>Edit / Requote</button></span></div>
          ))}
        </div>

        <div className="panel-sec stack">
          <div className="row between"><h3 style={{ margin: 0 }}>AI assistant</h3><span className="badge gray">draft only</span></div>
          {!me.environment.aiAvailable && <div className="small muted">AI is not configured. Everything else works normally.</div>}
          <div className="row">
            <button className="btn sm" disabled={aiBusy} onClick={() => runAi('summary')}>Summarise</button>
            <button className="btn sm" disabled={aiBusy} onClick={() => runAi('extract')}>Extract trip</button>
            <button className="btn sm" disabled={aiBusy || d.quotes.length === 0} onClick={() => runAi('negotiation', { quoteId: d.quotes[0]?.id })}>Negotiation</button>
          </div>
          {aiBusy && <div className="small muted">Thinking…</div>}
          {aiErr && <div className="banner warn small">{aiErr}</div>}
          {d.summary && <div className="small"><strong>Summary</strong> <span className="muted">({d.summaryAt && new Date(d.summaryAt).toLocaleTimeString()})</span><br />{d.summary}</div>}
          {ai?.output?.fields && (
            <div className="small stack">
              <strong>Extracted (please verify){ai.simulated && <> <SimTag /></>}</strong>
              {Object.entries(ai.output.fields).map(([k, v]) => <div key={k} className="row between"><span className="muted">{k}</span><span>{v === null ? <em className="muted">unknown</em> : String(v)}</span></div>)}
              <button className="btn sm blue" onClick={() => setBuilder({ prefill: extractToPrefill(ai.output) })}>Start quote with these (editable)</button>
            </div>
          )}
          {ai?.output?.suggestedDiscountPercent != null && <div className="small banner warn">Suggested discount: {ai.output.suggestedDiscountPercent}% — not applied. Staff must decide.</div>}
        </div>

        <div className="panel-sec stack">
          <h3>Internal notes <span className="muted small">(never sent to the customer)</span></h3>
          {d.notes.map((n: any) => <div key={n.id} className="small" style={{ background: 'var(--amberbg)', padding: 8, borderRadius: 8 }}>{n.text}<div className="muted">{n.author} · {fmtRelative(n.createdAt)}</div></div>)}
          <div className="row" style={{ flexWrap: 'nowrap' }}><input aria-label="Add note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" /><button className="btn sm" onClick={() => note.trim() && run(() => api(`/inbox/conversations/${id}/notes`, { body: { text: note } })).then(() => { setNote(''); reload(); })}>Add</button></div>
        </div>

        {me.environment.whatsappSimulated && <SimulatorPanel onDone={reload} />}
      </section>

      {builder && <QuoteBuilder conversationId={id} quoteId={builder.quoteId} prefill={builder.prefill} onClose={() => { setBuilder(null); reload(); }} onChanged={reload} />}
    </>
  );
}

/** Development-only controls. Events go through the same webhook pipeline as production. */
function SimulatorPanel({ onDone }: { onDone: () => void }) {
  const run = useAction();
  const [from, setFrom] = useState('+919900000099'), [name, setName] = useState('Test Customer'), [text, setText] = useState('Need an Innova Crysta Bangalore to Coorg, 3 days, 5 people');
  const fail = (kind: string) => run(() => api('/dev/simulator/fail-next', { body: { kind, count: 1 } }), `Next ${kind} send will fail`);
  return (
    <div className="panel-sec stack" style={{ background: '#fffbe6' }}>
      <div className="row between"><h3 style={{ margin: 0 }}>WhatsApp simulator</h3><SimTag /></div>
      <div className="small muted">Development only. Nothing here reaches real WhatsApp.</div>
      <input aria-label="Customer phone" value={from} onChange={(e) => setFrom(e.target.value)} /><input aria-label="Customer name" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea aria-label="Simulated customer message" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <button className="btn sm" onClick={() => run(() => api('/dev/simulator/inbound', { body: { from, name, text } }), 'Inbound message received').then(onDone)}>Receive text</button>
        <button className="btn sm" onClick={() => run(() => api('/dev/simulator/inbound', { body: { from, name, text, type: 'image' } }), 'Inbound photo received').then(onDone)}>Receive photo</button>
      </div>
      <div className="small"><strong>Failure injection</strong></div>
      <div className="row"><button className="btn sm" onClick={() => fail('image')}>Fail next image</button><button className="btn sm" onClick={() => fail('document')}>Fail next PDF</button><button className="btn sm" onClick={() => fail('text')}>Fail next text</button></div>
      <div className="row"><button className="btn sm" onClick={() => run(() => api('/dev/simulator/ai-fail-next', { body: {} }), 'Next AI call will fail')}>Fail next AI call</button><button className="btn sm" onClick={() => run(() => api('/dev/jobs/tick', { body: {} }), 'Job queue processed').then(onDone)}>Run job queue</button></div>
    </div>
  );
}
