'use client';
import { useState } from 'react';
import { api, useApi } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Empty, ErrorBox, Field, Loading, Modal, StatusBadge, useAction } from '@/components/ui';

export default function Platform() {
  const run = useAction();
  const [search, setSearch] = useState(''), [creating, setCreating] = useState(false), [invite, setInvite] = useState('');
  const agencies = useApi<any[]>(`/platform/agencies?search=${encodeURIComponent(search)}`);
  const settings = useApi<any>('/platform/settings');
  const errors = useApi<any[]>('/platform/errors');
  const [f, setF] = useState({ name: '', slug: '', adminName: '', adminEmail: '', aiMonthlyLimit: '200' });

  return (
    <>
      <div className="page-head"><div><h1>Agencies</h1><div className="muted small">Platform administration. Agency customer conversations are not visible here.</div></div>
        <div className="row"><input type="search" aria-label="Search agencies" placeholder="Search agencies" value={search} onChange={(e) => setSearch(e.target.value)} /><button className="btn primary" onClick={() => setCreating(true)}>＋ Create agency</button></div></div>
      {invite && <div className="banner warn small" style={{ marginBottom: 12 }}>Development mode: admin invite link <a href={invite}>{invite}</a></div>}
      <ErrorBox e={agencies.error} retry={agencies.reload} />
      <div className="card table-wrap">
        {agencies.loading && !agencies.data ? <Loading /> : agencies.data?.length === 0 ? <Empty>No agencies yet.</Empty> : (
          <table><thead><tr><th>Agency</th><th>Status</th><th>Users</th><th>Chats</th><th>Quotes</th><th>AI calls (month)</th><th>Failed jobs</th><th /></tr></thead><tbody>{agencies.data?.map((a) => (
            <tr key={a.id}><td><strong>{a.name}</strong><div className="small muted">{a.slug} · {a.plan}</div></td><td><StatusBadge s={a.status} /></td><td>{a.usage.users}</td><td>{a.usage.conversations}</td><td>{a.usage.quotes}</td>
              <td>{a.usage.aiCalls}/{a.aiMonthlyLimit || '∞'}</td><td>{a.usage.failedJobs > 0 ? <span className="badge red">{a.usage.failedJobs}</span> : 0}</td>
              <td><div className="row">
                {a.status === 'suspended'
                  ? <button className="btn sm" onClick={() => run(() => api(`/platform/agencies/${a.id}`, { method: 'PATCH', body: { status: 'active' } }), 'Reactivated').then(agencies.reload)}>Reactivate</button>
                  : <button className="btn sm danger" onClick={() => run(() => api(`/platform/agencies/${a.id}`, { method: 'PATCH', body: { status: 'suspended' } }), 'Suspended').then(agencies.reload)}>Suspend</button>}
                <button className="btn sm" onClick={() => run(async () => { const r = await api(`/platform/agencies/${a.id}/reinvite-admin`, { body: {} }); setInvite(r.inviteUrl ?? ''); }, 'Invitation re-sent')}>Re-invite admin</button>
              </div></td></tr>))}</tbody></table>
        )}
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card stack"><h2>AI kill switch</h2>
          <div className="small muted">Disables every AI feature for all agencies immediately. Inbox and quoting continue to work.</div>
          <label className="inline"><input type="checkbox" checked={!!settings.data?.aiKillSwitch} onChange={(e) => run(() => api('/platform/settings', { method: 'PATCH', body: { aiKillSwitch: e.target.checked } }), e.target.checked ? 'AI disabled platform-wide' : 'AI re-enabled').then(settings.reload)} />AI disabled platform-wide</label></div>
        <div className="card stack"><h2>Operational errors</h2>
          {errors.data?.length === 0 ? <div className="muted small">No failed background jobs.</div> : errors.data?.map((e) => <div key={e.id} className="small"><strong>{e.type}</strong> · {fmtDateTime(e.createdAt)}<br /><span className="muted">{e.lastError}</span></div>)}</div>
      </div>

      {creating && (
        <Modal title="Create agency" narrow onClose={() => setCreating(false)}>
          <div className="stack">
            <Field label="Agency display name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: f.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') })} /></Field>
            <Field label="Slug"><input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} /></Field>
            <Field label="Admin name"><input value={f.adminName} onChange={(e) => setF({ ...f, adminName: e.target.value })} /></Field>
            <Field label="Admin email"><input type="email" value={f.adminEmail} onChange={(e) => setF({ ...f, adminEmail: e.target.value })} /></Field>
            <Field label="AI calls per month (0 = unlimited)"><input type="number" min={0} value={f.aiMonthlyLimit} onChange={(e) => setF({ ...f, aiMonthlyLimit: e.target.value })} /></Field>
            <button className="btn primary" onClick={() => run(async () => { const r = await api('/platform/agencies', { body: { ...f, aiMonthlyLimit: Number(f.aiMonthlyLimit) } }); setInvite(r.inviteUrl ?? ''); setCreating(false); setF({ name: '', slug: '', adminName: '', adminEmail: '', aiMonthlyLimit: '200' }); }, 'Agency created, invitation sent').then(agencies.reload)}>Create & invite admin</button>
          </div>
        </Modal>
      )}
    </>
  );
}
