'use client';
import { useState } from 'react';
import { api, useApi } from '@/lib/api';
import { fmtDateTime, inr } from '@/lib/format';
import { Empty, ErrorBox, Field, Loading, SimTag, StatusBadge, useAction, useMe, useRefreshMe } from '@/components/ui';

const TABS = [['branding', 'Profile & branding'], ['team', 'Team'], ['whatsapp', 'WhatsApp'], ['templates', 'Templates'], ['quotes', 'Quotes, tax & AI'], ['audit', 'Audit log']];

export default function Settings() {
  const [tab, setTab] = useState('branding');
  return (
    <>
      <div className="page-head"><h1>Settings</h1></div>
      <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'branding' && <Branding />}
      {tab === 'team' && <Team />}
      {tab === 'whatsapp' && <WhatsApp />}
      {tab === 'templates' && <Templates />}
      {tab === 'quotes' && <QuoteSettings />}
      {tab === 'audit' && <Audit />}
    </>
  );
}

function Branding() {
  const run = useAction();
  const refreshMe = useRefreshMe();
  const { data, error, reload } = useApi<any>('/agency/branding');
  const [f, setF] = useState<any>(null);
  const v = f ?? data;
  if (error) return <ErrorBox e={error} retry={reload} />;
  if (!v) return <Loading />;
  const set = (k: string, val: string) => setF({ ...v, [k]: val });
  // After any branding change: refetch this form AND the app shell, so logo/colour update instantly without a page refresh.
  const refreshAll = async () => { await Promise.all([reload(), refreshMe()]); setF(null); };
  const save = () => run(() => api('/agency/branding', { method: 'PATCH', body: { brandColour: v.brandColour, tagline: v.tagline ?? null, phone: v.phone ?? null, email: v.email || null, website: v.website ?? null, address: v.address ?? null, footer: v.footer ?? null, terms: v.terms ?? null, inclusions: v.inclusions ?? null, exclusions: v.exclusions ?? null } }), 'Branding saved').then((r) => (r === undefined ? undefined : refreshAll()));
  return (
    <div className="card stack" style={{ maxWidth: 820 }}>
      <div className="row">
        {data.logoUrl ? <img src={data.logoUrl} alt="Agency logo" style={{ height: 56, borderRadius: 8, border: '1px solid var(--line)' }} /> : <div className="muted">No logo</div>}
        <label className="btn">Upload logo (JPEG/PNG)<input hidden type="file" accept="image/jpeg,image/png" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; const form = new FormData(); form.append('file', file); void run(() => api('/agency/branding/logo', { form }), 'Logo updated').then((r) => (r === undefined ? undefined : refreshAll())); e.target.value = ''; }} /></label>
      </div>
      <div className="fields">
        <Field label="Brand colour"><input type="color" value={v.brandColour} onChange={(e) => set('brandColour', e.target.value)} /></Field>
        <Field label="Tagline"><input value={v.tagline ?? ''} onChange={(e) => set('tagline', e.target.value)} /></Field>
        <Field label="Phone"><input value={v.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="Email"><input value={v.email ?? ''} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Website"><input value={v.website ?? ''} onChange={(e) => set('website', e.target.value)} /></Field>
      </div>
      <Field label="Address"><input value={v.address ?? ''} onChange={(e) => set('address', e.target.value)} /></Field>
      <div className="fields">
        <Field label="Default inclusions"><textarea value={v.inclusions ?? ''} onChange={(e) => set('inclusions', e.target.value)} /></Field>
        <Field label="Default exclusions"><textarea value={v.exclusions ?? ''} onChange={(e) => set('exclusions', e.target.value)} /></Field>
      </div>
      <Field label="Terms & conditions"><textarea value={v.terms ?? ''} onChange={(e) => set('terms', e.target.value)} /></Field>
      <Field label="Quote footer"><input value={v.footer ?? ''} onChange={(e) => set('footer', e.target.value)} /></Field>
      <div><button className="btn primary" onClick={save}>Save branding</button></div>
    </div>
  );
}

function Team() {
  const me = useMe(), run = useAction();
  const { data, error, reload } = useApi<any[]>('/agency/users');
  const [f, setF] = useState({ name: '', email: '', role: 'SALES' }), [invite, setInvite] = useState('');
  return (
    <div className="stack">
      <ErrorBox e={error} retry={reload} />
      <div className="card stack">
        <h2>Invite a team member</h2>
        <div className="fields">
          <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Role"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="SALES">Sales team</option><option value="AGENCY_ADMIN">Agency admin</option></select></Field>
        </div>
        <div><button className="btn primary" onClick={() => run(async () => { const r = await api('/agency/users', { body: f }); setInvite(r.inviteUrl ?? ''); setF({ name: '', email: '', role: 'SALES' }); }, 'Invitation sent').then(reload)}>Send invite</button></div>
        {invite && <div className="banner warn small">Development mode: invite link <a href={invite}>{invite}</a></div>}
      </div>
      <div className="card table-wrap">
        <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Can change rates</th><th /></tr></thead>
          <tbody>{data?.map((u) => (
            <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.role.replace('_', ' ').toLowerCase()}</td><td><StatusBadge s={u.status} /></td>
              <td>{u.role === 'SALES' ? <input type="checkbox" aria-label={`${u.name} can change rates`} style={{ width: 'auto' }} checked={u.canOverrideRates} onChange={(e) => run(() => api(`/agency/users/${u.id}`, { method: 'PATCH', body: { canOverrideRates: e.target.checked } })).then(reload)} /> : 'always'}</td>
              <td>{u.status !== 'disabled' && <button className="btn sm" title="Send a new set-password link" onClick={() => run(async () => { const r = await api(`/agency/users/${u.id}/reinvite`, { body: {} }); setInvite(r.inviteUrl ?? ''); }, u.status === 'invited' ? 'Invitation re-sent' : 'Password reset link sent')}>{u.status === 'invited' ? 'Resend invite' : 'Reset password'}</button>} {u.id !== me.user.id && (u.status === 'disabled'
                ? <button className="btn sm" onClick={() => run(() => api(`/agency/users/${u.id}`, { method: 'PATCH', body: { status: 'active' } })).then(reload)}>Enable</button>
                : <button className="btn sm danger" onClick={() => run(() => api(`/agency/users/${u.id}`, { method: 'PATCH', body: { status: 'disabled' } }), 'User disabled').then(reload)}>Disable</button>)}</td></tr>))}</tbody></table>
      </div>
    </div>
  );
}

function WhatsApp() {
  const me = useMe(), run = useAction();
  const { data, error, reload } = useApi<any>('/agency/whatsapp');
  const [f, setF] = useState({ displayName: '', wabaId: '', phoneNumberId: '', accessToken: '' });
  const cloud = !me.environment.whatsappSimulated;
  if (error) return <ErrorBox e={error} retry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="card stack" style={{ maxWidth: 640 }}>
      <div className="row between"><h2 style={{ margin: 0 }}>WhatsApp Business connection</h2>{data.simulated && <SimTag />}</div>
      {data.connected ? (
        <>
          <div className="row"><StatusBadge s={data.connectionStatus} /><span>{data.displayName}</span></div>
          <div className="small muted">Phone number ID: {data.phoneNumberId} · mode: {data.mode} · credential stored encrypted: {data.hasCredential ? 'yes' : 'no'}</div>
          {data.simulated && <div className="banner warn small">This is the local simulator. No real WhatsApp account is connected and no real messages are sent.</div>}
        </>
      ) : <div className="muted">Not connected.</div>}
      <h3>{data.connected ? 'Reconnect' : 'Connect'}</h3>
      {cloud && <div className="small muted">Complete Meta Embedded Signup, then paste the WABA ID, phone number ID and a system-user access token. The token is encrypted at rest and never shown again.</div>}
      <Field label="Display name"><input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
      {cloud && <div className="fields"><Field label="WABA ID"><input value={f.wabaId} onChange={(e) => setF({ ...f, wabaId: e.target.value })} /></Field><Field label="Phone number ID"><input value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value })} /></Field><Field label="Access token"><input type="password" autoComplete="off" value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} /></Field></div>}
      <div><button className="btn primary" onClick={() => run(() => api('/agency/whatsapp/connect', { body: cloud ? f : { displayName: f.displayName } }), 'Connected').then(reload)}>{data.connected ? 'Update connection' : 'Connect'}</button></div>
    </div>
  );
}

function Templates() {
  const me = useMe(), run = useAction();
  const { data, error, reload } = useApi<any[]>('/agency/whatsapp/templates');
  const [f, setF] = useState({ name: '', body: '', vars: '' });
  return (
    <div className="stack">
      <ErrorBox e={error} retry={reload} />
      <div className="banner ok small">Status is whatever the provider reports. A template is never treated as approved until the provider confirms it.</div>
      <div className="card stack">
        <h2>New template draft</h2>
        <div className="fields"><Field label="Name (lowercase_underscores)"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Variable names, comma separated"><input value={f.vars} onChange={(e) => setF({ ...f, vars: e.target.value })} placeholder="customer_name, quote_number" /></Field></div>
        <Field label="Body (use {{1}}, {{2}} …)"><textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <div><button className="btn primary" onClick={() => run(() => api('/agency/whatsapp/templates', { body: { name: f.name, body: f.body, variableSchema: f.vars.split(',').map((s) => s.trim()).filter(Boolean) } }), 'Draft saved').then(() => { setF({ name: '', body: '', vars: '' }); reload(); })}>Save draft</button></div>
      </div>
      <div className="card table-wrap">
        {data?.length === 0 ? <Empty>No templates.</Empty> : (
          <table><thead><tr><th>Name</th><th>Body</th><th>Provider status</th><th /></tr></thead><tbody>{data?.map((t) => (
            <tr key={t.id}><td>{t.name}</td><td className="small">{t.body}</td><td><StatusBadge s={t.providerStatus} /></td>
              <td><div className="row">
                {t.providerStatus === 'local_draft' && <button className="btn sm" onClick={() => run(() => api(`/agency/whatsapp/templates/${t.id}/submit`, { body: {} }), 'Submitted').then(reload)}>Submit for approval</button>}
                {me.environment.whatsappSimulated && ['submitted', 'pending'].includes(t.providerStatus) && <><SimTag /><button className="btn sm" onClick={() => run(() => api('/dev/simulator/template-decision', { body: { templateId: t.id, status: 'approved' } })).then(reload)}>Simulate approve</button><button className="btn sm" onClick={() => run(() => api('/dev/simulator/template-decision', { body: { templateId: t.id, status: 'rejected' } })).then(reload)}>Simulate reject</button></>}
              </div></td></tr>))}</tbody></table>
        )}
      </div>
    </div>
  );
}

function QuoteSettings() {
  const run = useAction();
  const { data, error, reload } = useApi<any>('/agency/settings');
  const [f, setF] = useState<any>(null);
  const v = f ?? data;
  if (error) return <ErrorBox e={error} retry={reload} />;
  if (!v) return <Loading />;
  const set = (k: string, val: any) => setF({ ...v, [k]: val });
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="card stack">
        <h2>Quotes & tax</h2>
        <div className="fields">
          <Field label="Sales team visibility"><select value={v.salesVisibility} onChange={(e) => set('salesVisibility', e.target.value)}><option value="all">All agency chats and quotes</option><option value="assigned">Only assigned chats / own quotes</option></select></Field>
          <Field label="Quote validity (days)"><input type="number" min={1} max={90} value={v.quoteValidityDays} onChange={(e) => set('quoteValidityDays', Number(e.target.value))} /></Field>
        </div>
        <label className="inline"><input type="checkbox" checked={v.taxEnabled} onChange={(e) => set('taxEnabled', e.target.checked)} />Charge tax on quotes</label>
        {v.taxEnabled && <div className="fields"><Field label="Tax rate (%)"><input type="number" min={0} max={100} step="0.01" value={v.taxRatePercent} onChange={(e) => set('taxRatePercent', Number(e.target.value))} /></Field><Field label="Prices are"><select value={v.taxMode} onChange={(e) => set('taxMode', e.target.value)}><option value="exclusive">Exclusive (tax added on top)</option><option value="inclusive">Inclusive (tax contained in total)</option></select></Field></div>}
        <div className="small muted">Discounts are applied before tax. Tax applies only to lines marked taxable. Rates are never hard-coded: they are whatever you set here.</div>
      </div>
      <div className="card stack">
        <h2>AI assistance</h2>
        <label className="inline"><input type="checkbox" checked={v.aiEnabled} onChange={(e) => set('aiEnabled', e.target.checked)} />Enable AI drafts for this agency</label>
        <div className="small muted">This month: {v.aiUsage.calls} calls · {v.aiUsage.inputTokens + v.aiUsage.outputTokens} tokens · est. ${v.aiUsage.estimatedCost} · limit {v.aiMonthlyLimit === 0 ? 'unlimited' : v.aiMonthlyLimit} (set by TripOS)</div>
      </div>
      <div><button className="btn primary" onClick={() => run(() => api('/agency/settings', { method: 'PATCH', body: { salesVisibility: v.salesVisibility, quoteValidityDays: v.quoteValidityDays, taxEnabled: v.taxEnabled, taxRatePercent: Number(v.taxRatePercent), taxMode: v.taxMode, aiEnabled: v.aiEnabled } }), 'Settings saved').then(() => { setF(null); reload(); })}>Save settings</button></div>
    </div>
  );
}

function Audit() {
  const me = useMe();
  const { data, error, reload } = useApi<any[]>('/agency/audit');
  return (
    <div className="card table-wrap"><ErrorBox e={error} retry={reload} />
      <table><thead><tr><th>When</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>{data?.map((a) => (
        <tr key={a.id}><td className="small">{fmtDateTime(a.createdAt, me.agency?.timezone)}</td><td>{a.action}</td><td className="small muted">{a.entityType}</td><td className="small muted">{JSON.stringify(a.metadata).slice(0, 120)}</td></tr>))}</tbody></table>
    </div>
  );
}
