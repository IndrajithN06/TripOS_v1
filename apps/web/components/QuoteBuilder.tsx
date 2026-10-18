'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, useApi } from '@/lib/api';
import { fmtDateTime, inr, isoToZoned, zonedToIso } from '@/lib/format';
import { Field, Modal, SimTag, StatusBadge, errMsg, useAction, useMe } from './ui';
import { QuotePreview } from './QuotePreview';
import { SendQuoteModal } from './SendQuoteModal';
import { defaultPhotoSelection, sanitizeSelection, selectionSummary, toggleSelection } from '@/lib/photos';

type Charge = { label: string; amount: string; taxable: boolean };
interface Form {
  tripType: 'local_8h_80km' | 'local_4h_40km' | 'outstation'; pickupLocal: string; returnLocal: string; pickupLocation: string; destinations: string; itinerary: string;
  passengers: string; days: string; hours: string; km: string; minKmMode: 'trip' | 'daily'; vehicleTypeId: string; overrides: Record<string, string>;
  extraCharges: Charge[]; discountType: 'amount' | 'percent'; discountValue: string; includeDriverBatta: boolean; inclusions: string; exclusions: string; notes: string; terms: string; imageAssetIds: string[];
}
const OVERRIDE_FIELDS: [string, string, string[]][] = [
  ['local8h80kmPrice', '8 hr / 80 km package', ['local_8h_80km']], ['local4h40kmPrice', '4 hr / 40 km package', ['local_4h_40km']],
  ['extraHourRate', 'Extra hour', ['local_8h_80km', 'local_4h_40km']], ['extraKmRate', 'Extra km', ['local_8h_80km', 'local_4h_40km']],
  ['outstationRatePerKm', 'Rate per km', ['outstation']], ['driverBattaPerDay', 'Driver batta / day', ['outstation']],
];

function blank(tz: string): Form {
  const start = new Date(Date.now() + 86400000); start.setMinutes(0, 0, 0);
  return { tripType: 'outstation', pickupLocal: isoToZoned(start.toISOString(), tz), returnLocal: '', pickupLocation: '', destinations: '', itinerary: '', passengers: '4', days: '1', hours: '', km: '', minKmMode: 'trip', vehicleTypeId: '', overrides: {}, extraCharges: [], discountType: 'amount', discountValue: '', includeDriverBatta: true, inclusions: '', exclusions: '', notes: '', terms: '', imageAssetIds: [] };
}
function fromInput(i: any, tz: string): Form {
  const t = i.trip;
  return {
    tripType: t.tripType, pickupLocal: isoToZoned(t.pickupAt, tz), returnLocal: isoToZoned(t.returnAt, tz), pickupLocation: t.pickupLocation, destinations: (t.destinations ?? []).join(', '), itinerary: t.itinerary ?? '',
    passengers: String(t.passengers), days: String(t.days ?? 1), hours: t.hours?.toString() ?? '', km: t.km?.toString() ?? '', minKmMode: t.minKmMode ?? 'trip', vehicleTypeId: i.vehicleTypeId,
    overrides: Object.fromEntries(Object.entries(i.overrides ?? {}).map(([k, v]) => [k, String(v)])), extraCharges: (i.extraCharges ?? []).map((c: any) => ({ label: c.label, amount: String(c.amount), taxable: c.taxable })),
    discountType: i.discount?.type ?? 'amount', discountValue: i.discount?.value ?? '', includeDriverBatta: i.includeDriverBatta !== false, inclusions: i.inclusions ?? '', exclusions: i.exclusions ?? '', notes: i.notes ?? '', terms: i.terms ?? '', imageAssetIds: i.imageAssetIds ?? [],
  };
}

export function QuoteBuilder({ conversationId, customerId, quoteId, prefill, onClose, onChanged }: {
  conversationId?: string; customerId?: string; quoteId?: string; prefill?: Partial<Form>; onClose: () => void; onChanged?: () => void;
}) {
  const me = useMe();
  const tz = me.agency?.timezone ?? 'Asia/Kolkata';
  const run = useAction();
  const { data: vehicles } = useApi<any[]>('/agency/vehicle-types');
  const [quote, setQuote] = useState<any>(null);
  const [form, setForm] = useState<Form>(() => ({ ...blank(tz), ...prefill }));
  const [calc, setCalc] = useState<any>(null), [calcErr, setCalcErr] = useState('');
  const [preview, setPreview] = useState<any>(null), [sendResult, setSendResult] = useState<any>(null), [busy, setBusy] = useState(false);
  const [noPhotoPrompt, setNoPhotoPrompt] = useState(false);
  const photoSection = useRef<HTMLElement>(null), summary = useRef<HTMLElement>(null);
  const promptMode = useRef<'template' | 'plain'>('template');
  const [followUp, setFollowUp] = useState('');
  const [sendModal, setSendModal] = useState<{ quoteId: string; versionNumber: number } | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const load = useCallback(async (id: string) => {
    const q = await api(`/quotes/${id}`);
    setQuote(q);
    const cur = q.versions.find((v: any) => v.id === q.currentVersionId);
    setForm(fromInput({ ...cur.input, trip: cur.trip, vehicleTypeId: cur.vehicleTypeId, imageAssetIds: cur.imageAssetIds }, tz));
  }, [tz]);
  useEffect(() => { if (quoteId) void load(quoteId); }, [quoteId, load]);

  const vehicle = vehicles?.find((v) => v.id === form.vehicleTypeId);
  const photos = selectionSummary(vehicle, form.imageAssetIds);
  const current = quote?.versions.find((v: any) => v.id === quote.currentVersionId);
  const locked = !!current?.immutable; // current version already sent: saving creates a new version
  const canOverride = me.user.role === 'AGENCY_ADMIN' || me.user.canOverrideRates;

  const payload = useMemo(() => {
    const num = (s: string) => (s === '' ? undefined : Number(s));
    const pickupAt = zonedToIso(form.pickupLocal, tz), returnAt = zonedToIso(form.returnLocal, tz);
    return {
      vehicleTypeId: form.vehicleTypeId || undefined,
      trip: {
        tripType: form.tripType, pickupAt, returnAt: returnAt || null, pickupLocation: form.pickupLocation, destinations: form.destinations.split(',').map((s) => s.trim()).filter(Boolean),
        itinerary: form.itinerary || undefined, passengers: num(form.passengers), days: form.tripType === 'outstation' ? num(form.days) : undefined, hours: num(form.hours), km: num(form.km),
        minKmMode: form.tripType === 'outstation' ? form.minKmMode : undefined,
      },
      overrides: Object.fromEntries(Object.entries(form.overrides).filter(([, v]) => v !== '')),
      extraCharges: form.extraCharges.filter((c) => c.label && c.amount !== ''),
      discount: form.discountValue ? { type: form.discountType, value: form.discountValue } : null,
      includeDriverBatta: form.includeDriverBatta, inclusions: form.inclusions || null, exclusions: form.exclusions || null, notes: form.notes || null, terms: form.terms || null, imageAssetIds: sanitizeSelection(form.imageAssetIds, vehicle),
    };
  }, [form, tz, vehicle]);

  // Live total: provisional display only. The backend recomputes authoritatively on save/send.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    if (!form.vehicleTypeId || !payload.trip.pickupAt || !payload.trip.pickupLocation || !payload.trip.passengers) { setCalc(null); return; }
    timer.current = setTimeout(async () => {
      try { setCalc(await api('/quotes/calculate', { body: payload })); setCalcErr(''); } catch (e) { setCalc(null); setCalcErr(errMsg(e)); }
    }, 350);
    return () => clearTimeout(timer.current);
  }, [payload, form.vehicleTypeId]);

  async function save(): Promise<any | undefined> {
    return run(async () => {
      let q;
      if (!quote) q = await api('/quotes', { body: { ...payload, conversationId, customerId } });
      else if (locked) q = await api(`/quotes/${quote.id}/versions`, { body: payload });
      else q = await api(`/quotes/${quote.id}/draft`, { method: 'PATCH', body: payload });
      setQuote(q); onChanged?.();
      return q;
    }, locked ? 'New version created' : 'Draft saved');
  }

  async function doPreview() {
    setBusy(true);
    const q = await save();
    if (q) { const cur = q.versions.find((v: any) => v.id === q.currentVersionId); await run(async () => setPreview(await api(`/quotes/${q.id}/versions/${cur.versionNumber}/preview`))); }
    setBusy(false);
  }
  async function doSend(skipPhotoCheck = false) {
    // Staff must not send a quote without photos by accident when the vehicle has some: ask first.
    if (photos.needsWarning && !skipPhotoCheck) {
      promptMode.current = 'plain';
      setNoPhotoPrompt(true);
      photoSection.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setNoPhotoPrompt(false);
    setBusy(true);
    const q = await save();
    if (q) {
      const cur = q.versions.find((v: any) => v.id === q.currentVersionId);
      const r = await run(() => api(`/quotes/${q.id}/versions/${cur.versionNumber}/send`, { body: { followUpAt: followUp ? zonedToIso(followUp, tz) : null } }));
      if (r) { setSendResult(r); await load(q.id); onChanged?.(); }
    }
    setBusy(false);
  }
  /** Saves the form, then opens the template send dialog for the saved current version. */
  async function openTemplateSend(skipPhotoCheck = false) {
    if (photos.needsWarning && !skipPhotoCheck) { promptMode.current = 'template'; setNoPhotoPrompt(true); photoSection.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    setNoPhotoPrompt(false);
    setBusy(true);
    const q = await save();
    if (q) { const cur = q.versions.find((v: any) => v.id === q.currentVersionId); await load(q.id); setSendModal({ quoteId: q.id, versionNumber: cur.versionNumber }); }
    setBusy(false);
  }
  async function retry() {
    if (!quote) return;
    const cur = quote.versions.find((v: any) => v.id === quote.currentVersionId);
    const r = await run(() => api(`/quotes/${quote.id}/versions/${cur.versionNumber}/retry`, { body: {} }));
    if (r) { setSendResult(r); await load(quote.id); onChanged?.(); }
  }

  const togglePhoto = (id: string) => { set('imageAssetIds', toggleSelection(form.imageAssetIds, id)); setNoPhotoPrompt(false); };
  const isLocal = form.tripType !== 'outstation';
  const days = useMemo(() => {
    const a = zonedToIso(form.pickupLocal, tz), b = zonedToIso(form.returnLocal, tz);
    return a && b ? Math.max(1, Math.ceil((+new Date(b) - +new Date(a)) / 86400000)) : null;
  }, [form.pickupLocal, form.returnLocal, tz]);
  useEffect(() => { if (days && form.tripType === 'outstation') setForm((f) => ({ ...f, days: String(days) })); }, [days, form.tripType]);

  return (
    <aside className="drawer qb-drawer" aria-label="Quote builder">
      <header className="qb-head">
        <div className="qb-title"><h1>{quote ? `Quote ${quote.quoteNumber}` : 'New quotation'}</h1>{quote && <StatusBadge s={quote.status} />}{current && <span className="badge">v{current.versionNumber}{locked ? ' · sent' : ''}</span>}</div>
        <button className="btn" onClick={onClose}>Close</button>
      </header>
      <div className="qb-body">
      {locked && <div className="banner warn" style={{ marginBottom: 12 }}>Version {current.versionNumber} was already sent and cannot be changed. Saving will create version {current.versionNumber + 1}; the sent version stays exactly as the customer received it.</div>}
      <div className="qb">
        <div className="stack">
          <section className="card stack">
            <h2><span className="qb-step" aria-hidden="true">1</span>Trip details</h2>
            <div className="fields">
              <Field label="Trip type"><select value={form.tripType} onChange={(e) => set('tripType', e.target.value as Form['tripType'])}>
                <option value="outstation">Outstation</option><option value="local_8h_80km">Local · 8 hr / 80 km</option><option value="local_4h_40km">Local · 4 hr / 40 km</option></select></Field>
              <Field label="Pickup date & time (IST)"><input type="datetime-local" value={form.pickupLocal} onChange={(e) => set('pickupLocal', e.target.value)} /></Field>
              <Field label="Return date & time"><input type="datetime-local" value={form.returnLocal} onChange={(e) => set('returnLocal', e.target.value)} /></Field>
              <Field label="Passengers"><input type="number" min={1} value={form.passengers} onChange={(e) => set('passengers', e.target.value)} /></Field>
            </div>
            <div className="fields">
              <Field label="Pickup location"><input value={form.pickupLocation} onChange={(e) => set('pickupLocation', e.target.value)} placeholder="e.g. Bangalore Airport" /></Field>
              <Field label="Destination(s), comma separated"><input value={form.destinations} onChange={(e) => set('destinations', e.target.value)} placeholder="Coorg, Mysore" /></Field>
            </div>
            <div className="fields">
              {!isLocal && <Field label="Days"><input type="number" min={1} value={form.days} onChange={(e) => set('days', e.target.value)} /></Field>}
              {isLocal && <Field label="Actual / estimated hours"><input type="number" min={0} step="0.5" value={form.hours} onChange={(e) => set('hours', e.target.value)} /></Field>}
              <Field label={isLocal ? 'Estimated km' : 'Estimated total km'}><input type="number" min={0} value={form.km} onChange={(e) => set('km', e.target.value)} /></Field>
              {!isLocal && <Field label="Minimum km rule"><select value={form.minKmMode} onChange={(e) => set('minKmMode', e.target.value as 'trip' | 'daily')}><option value="trip">Trip-wide (days × min km)</option><option value="daily" disabled>Daily (needs per-day km)</option></select></Field>}
            </div>
            <Field label="Itinerary"><textarea value={form.itinerary} onChange={(e) => set('itinerary', e.target.value)} placeholder="Day 1: …" /></Field>
          </section>

          <section className="card stack">
            <h2><span className="qb-step" aria-hidden="true">2</span>Vehicle &amp; pricing</h2>
            <Field label="Vehicle type"><select value={form.vehicleTypeId} onChange={(e) => {
              // A new vehicle starts with ITS primary photo selected; photos of the previous vehicle are never kept.
              const next = vehicles?.find((v) => v.id === e.target.value);
              setNoPhotoPrompt(false);
              setForm((f) => ({ ...f, vehicleTypeId: e.target.value, imageAssetIds: defaultPhotoSelection(next), overrides: {} }));
            }}>
              <option value="">Select a vehicle…</option>{vehicles?.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.seats} seats</option>)}</select></Field>
            {vehicle && (
              <>
                <div className="qb-note small muted">Rate card (snapshotted when the version is created): 8h/80km {inr(vehicle.rate.local8h80kmPrice)} · 4h/40km {inr(vehicle.rate.local4h40kmPrice)} · {inr(vehicle.rate.outstationRatePerKm)}/km · min {vehicle.rate.minKmPerDay} km/day · batta {inr(vehicle.rate.driverBattaPerDay)}</div>
                <div className="qb-sub"><strong className="small">Quote-specific rates</strong> {!canOverride && <span className="badge amber">Not permitted for your role</span>}</div>
                <div className="fields">
                  {OVERRIDE_FIELDS.filter(([, , t]) => t.includes(form.tripType)).map(([k, label]) => (
                    <Field key={k} label={`${label} (default ${inr(vehicle.rate[k])})`}>
                      <input type="number" min={0} disabled={!canOverride} placeholder={String(vehicle.rate[k])} value={form.overrides[k] ?? ''} onChange={(e) => set('overrides', { ...form.overrides, [k]: e.target.value })} />
                    </Field>
                  ))}
                </div>
                {!isLocal && <label className="inline"><input type="checkbox" checked={form.includeDriverBatta} onChange={(e) => set('includeDriverBatta', e.target.checked)} />Include driver batta</label>}
              </>
            )}
            <div className="qb-sub row between"><strong className="small">Extra charges</strong> <button className="btn sm" onClick={() => set('extraCharges', [...form.extraCharges, { label: '', amount: '', taxable: true }])}>+ Add</button></div>
            {form.extraCharges.map((c, i) => (
              <div className="charge-row" key={i}>
                <input placeholder="Toll / Parking / Permit…" value={c.label} onChange={(e) => set('extraCharges', form.extraCharges.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <input type="number" min={0} placeholder="Amount" value={c.amount} onChange={(e) => set('extraCharges', form.extraCharges.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                <label className="inline"><input type="checkbox" checked={c.taxable} onChange={(e) => set('extraCharges', form.extraCharges.map((x, j) => (j === i ? { ...x, taxable: e.target.checked } : x)))} />taxable</label>
                <button className="btn sm danger" aria-label="Remove charge" onClick={() => set('extraCharges', form.extraCharges.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <div className="fields">
              <Field label="Discount"><div className="row" style={{ flexWrap: 'nowrap' }}>
                <select style={{ width: 90 }} disabled={!canOverride} value={form.discountType} onChange={(e) => set('discountType', e.target.value as 'amount' | 'percent')}><option value="amount">₹</option><option value="percent">%</option></select>
                <input type="number" min={0} disabled={!canOverride} value={form.discountValue} onChange={(e) => set('discountValue', e.target.value)} /></div></Field>
            </div>
          </section>

          <section className="card stack" ref={photoSection}>
            <div className="row between">
              <h2 style={{ margin: 0 }}><span className="qb-step" aria-hidden="true">3</span>Vehicle photos for this customer</h2>
              {vehicle && photos.total > 0 && <span className={`badge ${photos.selected > 0 ? 'green' : 'amber'}`} aria-live="polite" data-testid="photo-count">{photos.label}</span>}
            </div>
            {!vehicle ? <div className="muted small">Select a vehicle to choose photos.</div> : vehicle.images.length === 0 ? <div className="muted small">This vehicle has no photos yet. Add some in Vehicle Types.</div> : (
              <>
                {photos.needsWarning && (
                  <div className={`banner warn small ${noPhotoPrompt ? 'attn' : ''}`} role="alert" data-testid="no-photo-warning">
                    <strong>No photos selected.</strong> This vehicle has {photos.total} photo{photos.total === 1 ? '' : 's'}, but the customer will receive this quote <strong>without any photos</strong> unless you select at least one below.
                  </div>
                )}
                <div className="photos">{vehicle.images.map((im: any) => {
                  const on = form.imageAssetIds.includes(im.assetId);
                  return (
                    <button type="button" key={im.id} className={`photo ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => togglePhoto(im.assetId)} title={im.caption ?? ''}>
                      <img src={im.url} alt={im.altText ?? im.caption ?? vehicle.name} />
                      {on && <span className="tick" aria-hidden>✓</span>}
                      <span className="pill">{on ? 'Selected' : 'Tap to add'}</span>
                    </button>
                  );
                })}</div>
              </>
            )}
            <div className="small muted">Selected photos are sent as separate WhatsApp images after the PDF. {vehicle && vehicle.images.some((i: any) => i.isPrimary) && 'The vehicle\'s primary photo is selected by default; you can change it.'}</div>
          </section>

          <section className="card stack">
            <h2><span className="qb-step" aria-hidden="true">4</span>Notes &amp; terms</h2>
            <div className="fields">
              <Field label="Inclusions"><textarea value={form.inclusions} onChange={(e) => set('inclusions', e.target.value)} placeholder="Defaults from agency branding" /></Field>
              <Field label="Exclusions"><textarea value={form.exclusions} onChange={(e) => set('exclusions', e.target.value)} placeholder="Defaults from agency branding" /></Field>
            </div>
            <Field label="Notes for the customer"><textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
            <Field label="Terms (leave blank to use agency terms)"><textarea value={form.terms} onChange={(e) => set('terms', e.target.value)} /></Field>
          </section>
        </div>

        <div className="side stack">
          <section className="card stack qb-summary" aria-live="polite" ref={summary}>
            <h2>Price summary</h2>
            {calcErr && <div className="banner err">{calcErr}</div>}
            {!calc && !calcErr && <div className="muted small">Fill in the trip and vehicle to see the price.</div>}
            {calc && (
              <table className="lines"><tbody>
                {calc.lines.map((l: any, i: number) => <tr key={i}><td>{l.label}</td><td className="right mono">{inr(l.amount)}</td></tr>)}
                {Number(calc.discount) > 0 && <tr><td className="muted">Discount</td><td className="right mono">− {inr(calc.discount)}</td></tr>}
                {Number(calc.tax) > 0 && <tr><td className="muted">Tax ({calc.taxRatePercent}%{calc.taxMode === 'inclusive' ? ', incl.' : ''})</td><td className="right mono">{inr(calc.tax)}</td></tr>}
                <tr className="total"><td>Total</td><td className="right mono">{inr(calc.total)}</td></tr>
              </tbody></table>
            )}
            <div className="small muted">Calculated by the server. The final total is re-validated when you save or send.</div>
            <Field label="Follow-up reminder (optional)"><input type="datetime-local" value={followUp} onChange={(e) => setFollowUp(e.target.value)} /></Field>
            <button className="btn" disabled={busy || !form.vehicleTypeId} onClick={doPreview}>Save & preview</button>
            {noPhotoPrompt && photos.needsWarning && (
              <div className="banner warn small stack" role="alertdialog" aria-label="Send without photos?" data-testid="no-photo-prompt">
                <div><strong>Send without photos?</strong> This vehicle has {photos.total} photo{photos.total === 1 ? '' : 's'}, but none are selected.</div>
                <div className="row">
                  <button className="btn sm primary" onClick={() => { set('imageAssetIds', defaultPhotoSelection(vehicle)); setNoPhotoPrompt(false); }}>Select the primary photo</button>
                  <button className="btn sm" onClick={() => void (promptMode.current === 'template' ? openTemplateSend(true) : doSend(true))}>Send without photos</button>
                </div>
              </div>
            )}
            <button className="btn primary" disabled={busy || !calc} onClick={() => void openTemplateSend()}>{locked ? `Save v${current.versionNumber + 1} & send quotation on WhatsApp` : 'Send Quotation on WhatsApp'}</button>
            <button className="btn" disabled={busy || !calc} title="Plain text, PDF and photos. WhatsApp allows this only within 24 hours of the customer's last message." onClick={() => void doSend()}>{locked ? `Save v${current.versionNumber + 1} & send as plain messages` : 'Send as plain messages (24h window)'}</button>
            <button className="btn" disabled={busy || !form.vehicleTypeId} onClick={() => save()}>{locked ? 'Create new version (draft)' : 'Save draft'}</button>
            {me.environment.whatsappSimulated && <div className="small"><SimTag /> Sends go to the local simulator only.</div>}
          </section>

          {sendResult && (
            <section className="card stack">
              <h2>Delivery</h2>
              <div className="row"><StatusBadge s={sendResult.versionStatus} /><span className="small muted">version {sendResult.versionNumber}</span></div>
              {sendResult.attempts.map((a: any, i: number) => (
                <div className="row between small" key={i}><span>{a.kind === 'template' ? 'WhatsApp template message' : a.kind === 'text' ? 'Message' : a.kind === 'pdf' ? 'Quotation PDF' : 'Vehicle photo'}</span><span><StatusBadge s={a.status} /></span></div>
              ))}
              {sendResult.attempts.some((a: any) => a.error) && <div className="banner err small">{sendResult.attempts.find((a: any) => a.error)?.error}</div>}
              {sendResult.versionStatus !== 'sent' && <button className="btn blue" onClick={retry}>Retry failed items only</button>}
            </section>
          )}
          {quote && quote.versions.length > 1 && (
            <section className="card"><h2>Versions</h2>{quote.versions.map((v: any) => <div className="row between small" key={v.id}><span>v{v.versionNumber} · {fmtDateTime(v.createdAt, tz)}</span><span className="mono">{inr(v.total)} <StatusBadge s={v.status} /></span></div>)}</section>
          )}
        </div>
      </div>
      </div>
      <div className="qb-totalbar" role="status">
        <div><span className="small muted">Total</span><strong className="mono">{calc ? inr(calc.total) : '—'}</strong></div>
        <button className="btn primary sm" onClick={() => summary.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Review &amp; send ↓</button>
      </div>
      {sendModal && <SendQuoteModal quoteId={sendModal.quoteId} versionNumber={sendModal.versionNumber} onClose={() => setSendModal(null)} onSent={() => { void load(sendModal.quoteId); onChanged?.(); }} />}
      {preview && <Modal title="Customer preview" onClose={() => setPreview(null)}>
        <QuotePreview p={preview} />
        <div className="row" style={{ marginTop: 12 }}><a className="btn" target="_blank" rel="noreferrer" href={`/api/quotes/${quote.id}/versions/${preview.versionNumber}/pdf`}>Open PDF</a></div>
      </Modal>}
    </aside>
  );
}
