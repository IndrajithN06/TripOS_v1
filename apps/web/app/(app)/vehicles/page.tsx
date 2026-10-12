'use client';
import { useState } from 'react';
import { api, useApi } from '@/lib/api';
import { inr } from '@/lib/format';
import { Empty, ErrorBox, Field, Loading, Modal, StatusBadge, errMsg, useAction, useMe } from '@/components/ui';

const CATEGORIES = ['sedan', 'hatchback', 'suv', 'mpv', 'tempo traveller', 'urbania', 'mini bus', 'bus', 'luxury'];
const RATE_FIELDS: [string, string][] = [
  ['local8h80kmPrice', 'Local 8 hr / 80 km price (₹)'], ['local4h40kmPrice', 'Local 4 hr / 40 km price (₹)'], ['extraHourRate', 'Extra hour (₹)'], ['extraKmRate', 'Extra km (₹)'],
  ['outstationRatePerKm', 'Outstation rate per km (₹)'], ['minKmPerDay', 'Minimum km per day'], ['driverBattaPerDay', 'Driver batta per day (₹)'],
  ['defaultToll', 'Default toll (₹, optional)'], ['defaultParking', 'Default parking (₹, optional)'], ['defaultPermit', 'Default permit (₹, optional)'], ['defaultInterstateTax', 'Default interstate tax (₹, optional)'],
];
const emptyRate = () => ({ local8hHours: 8, local8hKm: 80, local4hHours: 4, local4hKm: 40, local8h80kmPrice: '', local4h40kmPrice: '', extraHourRate: '', extraKmRate: '', outstationRatePerKm: '', minKmPerDay: '300', driverBattaPerDay: '', defaultToll: '', defaultParking: '', defaultPermit: '', defaultInterstateTax: '' });

export default function Vehicles() {
  const me = useMe();
  const isAdmin = me.user.role === 'AGENCY_ADMIN';
  const [archived, setArchived] = useState(false), [editing, setEditing] = useState<any>(null);
  const { data, error, loading, reload } = useApi<any[]>(`/agency/vehicle-types?includeArchived=${archived}`, [archived]);
  return (
    <>
      <div className="page-head"><h1>Vehicle Types</h1>
        <div className="row">
          <label className="inline"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />Show archived</label>
          {isAdmin && <button className="btn primary" onClick={() => setEditing('new')}>＋ Add vehicle type</button>}
        </div>
      </div>
      {!isAdmin && <div className="banner ok" style={{ marginBottom: 12 }}>You can view vehicle types and select them in quotes. Only agency admins can change rates and photos.</div>}
      <ErrorBox e={error} retry={reload} />
      {loading && !data && <Loading />}
      {data?.length === 0 && <div className="card"><Empty>No vehicle types yet.{isAdmin && ' Add your first one to start quoting.'}</Empty></div>}
      <div className="grid cols-4">
        {data?.map((v) => {
          const img = v.images.find((i: any) => i.isPrimary) ?? v.images[0];
          return (
            <div className="card stack" key={v.id} style={{ opacity: v.active ? 1 : .65 }}>
              <div style={{ height: 130, background: 'var(--bg)', borderRadius: 8, overflow: 'hidden' }}>{img ? <img src={img.url} alt={img.altText ?? v.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Empty>No photo</Empty>}</div>
              <div className="row between"><strong>{v.name}</strong>{!v.active && <StatusBadge s="disabled" />}</div>
              <div className="small muted">{v.category} · {v.seats} seats · {v.images.length} photo(s)</div>
              <div className="small">8h/80km <strong>{inr(v.rate?.local8h80kmPrice)}</strong><br />Outstation <strong>{inr(v.rate?.outstationRatePerKm)}</strong>/km · min {v.rate?.minKmPerDay} km/day</div>
              {isAdmin && <button className="btn sm" onClick={() => setEditing(v)}>Edit rates & photos</button>}
            </div>
          );
        })}
      </div>
      {editing && <VehicleEditor vehicle={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => reload()} />}
    </>
  );
}

function VehicleEditor({ vehicle, onClose, onSaved }: { vehicle: any | null; onClose: () => void; onSaved: () => void }) {
  const run = useAction();
  const [id, setId] = useState<string | null>(vehicle?.id ?? null);
  const [f, setF] = useState({ name: vehicle?.name ?? '', category: vehicle?.category ?? 'sedan', seats: String(vehicle?.seats ?? 4), description: vehicle?.description ?? '', amenities: (vehicle?.amenities ?? []).join(', ') });
  const [rate, setRate] = useState<Record<string, any>>(vehicle?.rate ? Object.fromEntries(Object.entries(vehicle.rate).map(([k, v]) => [k, v ?? ''])) : emptyRate());
  const [images, setImages] = useState<any[]>(vehicle?.images ?? []), [active, setActive] = useState(vehicle?.active ?? true), [uploading, setUploading] = useState(false), [err, setErr] = useState('');

  const rateBody = () => {
    const out: Record<string, any> = { local8hHours: Number(rate.local8hHours), local8hKm: Number(rate.local8hKm), local4hHours: Number(rate.local4hHours), local4hKm: Number(rate.local4hKm), minKmPerDay: Number(rate.minKmPerDay) };
    for (const k of ['local8h80kmPrice', 'local4h40kmPrice', 'extraHourRate', 'extraKmRate', 'outstationRatePerKm', 'driverBattaPerDay']) out[k] = String(rate[k]);
    for (const k of ['defaultToll', 'defaultParking', 'defaultPermit', 'defaultInterstateTax']) out[k] = rate[k] === '' || rate[k] == null ? null : String(rate[k]);
    return out;
  };
  async function save() {
    setErr('');
    const body = { name: f.name, category: f.category, seats: Number(f.seats), description: f.description || null, amenities: f.amenities.split(',').map((s: string) => s.trim()).filter(Boolean), rate: rateBody() };
    try {
      const v = id ? await api(`/agency/vehicle-types/${id}`, { method: 'PATCH', body }) : await api('/agency/vehicle-types', { body });
      setId(v.id); onSaved();
      if (!id) { setImages([]); return; } // stay open so photos can be added next
      onClose();
    } catch (e) { setErr(errMsg(e)); }
  }
  async function upload(files: FileList | null) {
    if (!files?.length || !id) return;
    setUploading(true); setErr('');
    for (const file of Array.from(files)) {
      const form = new FormData(); form.append('file', file); form.append('caption', file.name.replace(/\.[^.]+$/, ''));
      try { await api(`/agency/vehicle-types/${id}/images`, { form }); } catch (e) { setErr(`${file.name}: ${errMsg(e)}`); }
    }
    const v = await api(`/agency/vehicle-types/${id}`); setImages(v.images); setUploading(false); onSaved();
  }
  const refresh = async () => { const v = await api(`/agency/vehicle-types/${id}`); setImages(v.images); onSaved(); };
  async function move(i: number, d: number) {
    const ids = images.map((x) => x.id); const j = i + d; if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await run(() => api(`/agency/vehicle-types/${id}/images/order`, { method: 'PUT', body: { ids } })); await refresh();
  }

  return (
    <Modal title={vehicle ? `Edit ${vehicle.name}` : 'New vehicle type'} onClose={onClose}>
      {err && <div className="banner err" role="alert" style={{ marginBottom: 10 }}>{err}</div>}
      <div className="stack">
        <div className="fields">
          <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Category"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Seating capacity"><input type="number" min={1} value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value })} /></Field>
        </div>
        <Field label="Description"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Amenities (comma separated)"><input value={f.amenities} onChange={(e) => setF({ ...f, amenities: e.target.value })} placeholder="AC, Charging ports" /></Field>
        <h3>Rate card <span className="muted small">(quotes snapshot these values when a version is created)</span></h3>
        <div className="fields">
          <Field label="Local slab A hours"><input type="number" value={rate.local8hHours} onChange={(e) => setRate({ ...rate, local8hHours: e.target.value })} /></Field>
          <Field label="Local slab A km"><input type="number" value={rate.local8hKm} onChange={(e) => setRate({ ...rate, local8hKm: e.target.value })} /></Field>
          <Field label="Local slab B hours"><input type="number" value={rate.local4hHours} onChange={(e) => setRate({ ...rate, local4hHours: e.target.value })} /></Field>
          <Field label="Local slab B km"><input type="number" value={rate.local4hKm} onChange={(e) => setRate({ ...rate, local4hKm: e.target.value })} /></Field>
        </div>
        <div className="fields">{RATE_FIELDS.map(([k, label]) => <Field key={k} label={label}><input type="number" min={0} step="0.01" value={rate[k] ?? ''} onChange={(e) => setRate({ ...rate, [k]: e.target.value })} /></Field>)}</div>
        <div className="row"><button className="btn primary" onClick={save}>{id ? 'Save changes' : 'Create vehicle type'}</button>
          {id && <button className="btn danger" onClick={() => run(() => api(`/agency/vehicle-types/${id}/${active ? 'archive' : 'restore'}`, { body: {} }), active ? 'Archived' : 'Restored').then(() => { setActive(!active); onSaved(); })}>{active ? 'Archive' : 'Restore'}</button>}</div>

        <h3>Photos</h3>
        {!id ? <div className="muted small">Create the vehicle type first, then add photos.</div> : (
          <>
            <label className="btn" style={{ width: 'fit-content' }}>{uploading ? 'Uploading…' : '＋ Upload photos (JPEG/PNG, max 5 MB)'}
              <input type="file" accept="image/jpeg,image/png" multiple hidden disabled={uploading} onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} /></label>
            {images.length === 0 && <div className="muted small">No photos yet. Customers see the photos you attach to each quote.</div>}
            <div className="grid cols-4">{images.map((im, i) => (
              <div className="card stack" key={im.id} style={{ padding: 10 }}>
                <img src={im.url} alt={im.altText ?? im.caption ?? 'Vehicle photo'} style={{ width: '100%', height: 100, objectFit: 'cover', borderRadius: 6 }} />
                <input aria-label="Caption" defaultValue={im.caption ?? ''} placeholder="Caption" onBlur={(e) => e.target.value !== (im.caption ?? '') && run(() => api(`/agency/vehicle-types/${id}/images/${im.id}`, { method: 'PATCH', body: { caption: e.target.value } }))} />
                <input aria-label="Alt text" defaultValue={im.altText ?? ''} placeholder="Alt text (accessibility)" onBlur={(e) => e.target.value !== (im.altText ?? '') && run(() => api(`/agency/vehicle-types/${id}/images/${im.id}`, { method: 'PATCH', body: { altText: e.target.value } }))} />
                <div className="row">
                  {im.isPrimary ? <span className="badge green">Primary</span> : <button className="btn sm" onClick={() => run(() => api(`/agency/vehicle-types/${id}/images/${im.id}`, { method: 'PATCH', body: { isPrimary: true } })).then(refresh)}>Make primary</button>}
                  <button className="btn sm" aria-label="Move earlier" disabled={i === 0} onClick={() => move(i, -1)}>←</button><button className="btn sm" aria-label="Move later" disabled={i === images.length - 1} onClick={() => move(i, 1)}>→</button>
                  <button className="btn sm danger" onClick={() => run(() => api(`/agency/vehicle-types/${id}/images/${im.id}`, { method: 'DELETE' }), 'Photo removed').then(refresh)}>Remove</button>
                </div>
              </div>))}</div>
          </>
        )}
      </div>
    </Modal>
  );
}
