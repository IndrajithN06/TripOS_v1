'use client';
import { useEffect, useRef, useState } from 'react';
import { api, useApi } from '@/lib/api';
import { Empty, ErrorBox, Field, Loading, Modal, SimTag, StatusBadge, useAction, useMe } from '@/components/ui';
import { WaMedia, WaPreview, WaPreviewData } from '@/components/WaPreview';

const PURPOSES: [string, string][] = [['quotation', 'Quotation'], ['revised_quotation', 'Revised quotation'], ['followup', 'Follow-up'], ['enquiry_ack', 'Enquiry acknowledgement'], ['custom', 'Custom message']];
const ORIGIN: Record<string, { label: string; tone: string; hint: string }> = {
  local_draft: { label: 'Local draft', tone: 'gray', hint: 'Saved in TripOS only. Meta has not seen it yet.' },
  submitted_by_tripos: { label: 'Registered with Meta', tone: 'blue', hint: 'Submitted from TripOS. Status comes from Meta.' },
  imported_from_meta: { label: 'Imported from Meta', tone: 'blue', hint: 'Created in Meta Business Manager; TripOS cannot edit it.' },
};

interface Spec { purpose: string; header: { type: string; source?: string; text?: string }; body: string; footer?: string; buttons: any[] }
interface Form { id?: string; name: string; language: string; category: string; spec: Spec; headerMediaAssetId: string | null; headerMediaUrl?: string | null }
/** Meta needs an https link that ends in at most one variable. Local http addresses are rejected, so suggest a placeholder host to replace. */
const defaultLink = () => `${typeof location !== 'undefined' && location.protocol === 'https:' ? location.origin : 'https://your-domain.example'}/q/{{quote_token}}`;
const blank = (): Form => ({
  name: '', language: 'en', category: 'UTILITY', headerMediaAssetId: null,
  spec: { purpose: 'quotation', header: { type: 'image', source: 'vehicle_photo' }, body: 'Hello {{customer_name}} 👋\n\nThank you for choosing {{agency_name}}.\n\nDestination: {{destination}}\nTravel dates: {{travel_dates}}\nGuests: {{passenger_count}}\nVehicle: {{vehicle_type}}\n\nQuotation amount: {{quote_total}}', footer: '', buttons: [{ type: 'url', text: 'View Quotation', url: defaultLink() }] },
});

export function TemplateManager() {
  const me = useMe(), run = useAction();
  const isAdmin = me.user.role === 'AGENCY_ADMIN';
  const { data, error, reload } = useApi<any[]>('/agency/whatsapp/templates');
  const [editing, setEditing] = useState<Form | null>(null);
  const [viewing, setViewing] = useState<any>(null);

  const open = (t: any) => setEditing({ id: t.id, name: t.name, language: t.language, category: t.category, spec: { ...t.spec, footer: t.spec.footer ?? '' }, headerMediaAssetId: t.headerMediaAssetId });
  const sync = () => run(() => api('/agency/whatsapp/templates/sync', { body: {} }), 'Templates synced from WhatsApp').then(reload);

  return (
    <div className="stack">
      <ErrorBox e={error} retry={reload} />
      <div className="banner ok small row between">
        <span>Only templates that <strong>Meta has approved</strong> can be sent. A template is never treated as approved until the provider confirms it.</span>
        <span className="row">
          <button className="btn sm" onClick={sync}>{me.environment.whatsappSimulated ? 'Sync (simulated)' : 'Sync from Meta'}</button>
          {isAdmin && <button className="btn sm primary" onClick={() => setEditing(blank())}>+ New template</button>}
        </span>
      </div>
      {!data ? <Loading /> : data.length === 0 ? <Empty>No templates yet. {isAdmin ? 'Create your first quotation template.' : 'Ask an admin to create one.'}</Empty> : (
        <div className="card table-wrap">
          <table><thead><tr><th>Template</th><th>Purpose</th><th>Where it lives</th><th>Meta status</th><th /></tr></thead><tbody>{data.map((t) => {
            const o = ORIGIN[t.origin] ?? ORIGIN.local_draft;
            return (
              <tr key={t.id}>
                <td><strong>{t.name}</strong><div className="small muted">{t.language} · {t.category}{t.spec?.header?.type && t.spec.header.type !== 'none' ? ` · ${t.spec.header.type} header` : ''}{t.spec?.buttons?.length ? ` · ${t.spec.buttons.length} button${t.spec.buttons.length > 1 ? 's' : ''}` : ''}</div></td>
                <td className="small">{t.purposeLabel}</td>
                <td><span className={`badge ${o.tone}`} title={o.hint}>{o.label}</span></td>
                <td><StatusBadge s={t.status} />{t.rejectedReason && <div className="small" style={{ color: 'var(--red)' }}>{t.rejectedReason}</div>}{me.environment.whatsappSimulated && t.registeredWithMeta && <div><SimTag /></div>}</td>
                <td><div className="row">
                  <button className="btn sm" onClick={() => setViewing(t)}>Preview</button>
                  {isAdmin && t.editable && <button className="btn sm" onClick={() => open(t)}>Edit</button>}
                  {isAdmin && <button className="btn sm" onClick={() => run(() => api(`/agency/whatsapp/templates/${t.id}/duplicate`, { body: {} }), 'Duplicated as a new draft').then(reload)}>Duplicate</button>}
                  {isAdmin && t.editable && <button className="btn sm primary" onClick={() => run(() => api(`/agency/whatsapp/templates/${t.id}/submit`, { body: {} }), 'Submitted to Meta for review').then(reload)}>{t.status === 'rejected' ? 'Resubmit' : 'Submit to Meta'}</button>}
                  {isAdmin && t.status === 'local_draft' && <button className="btn sm danger" onClick={() => run(() => api(`/agency/whatsapp/templates/${t.id}`, { method: 'DELETE' }), 'Draft deleted').then(reload)}>Delete</button>}
                  {me.environment.whatsappSimulated && ['submitted', 'pending'].includes(t.status) && <><button className="btn sm" onClick={() => run(() => api('/dev/simulator/template-decision', { body: { templateId: t.id, status: 'approved' } })).then(reload)}>Simulate approve</button></>}
                </div></td>
              </tr>
            );
          })}</tbody></table>
        </div>
      )}
      {editing && <BuilderModal form={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
      {viewing && <Modal title={viewing.name} narrow onClose={() => setViewing(null)}><PreviewOnly template={viewing} /></Modal>}
    </div>
  );
}

function PreviewOnly({ template }: { template: any }) {
  const [res, setRes] = useState<any>(null), [err, setErr] = useState<any>(null);
  useEffect(() => { api('/agency/whatsapp/templates/preview', { body: { templateId: template.id } }).then(setRes).catch(setErr); }, [template.id]);
  if (err) return <ErrorBox e={err} />;
  if (!res) return <Loading />;
  return <div className="stack"><div className="small muted">Shown with sample customer data and your real agency details.</div><WaPreview preview={res.preview} media={res.headerMedia} /></div>;
}

function BuilderModal({ form, onClose, onSaved }: { form: Form; onClose: () => void; onSaved: () => void }) {
  const run = useAction();
  const [f, setF] = useState<Form>(form);
  const [res, setRes] = useState<any>(null), [serverIssues, setServerIssues] = useState<{ path: string; message: string }[]>([]);
  const { data: vars } = useApi<{ name: string; label: string; sample: string }[]>('/agency/whatsapp/templates/variables');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const spec = f.spec;
  const setSpec = (p: Partial<Spec>) => setF({ ...f, spec: { ...spec, ...p } });

  // live preview + validation, debounced
  useEffect(() => {
    const id = setTimeout(() => { api('/agency/whatsapp/templates/preview', { body: { spec: { ...spec, footer: spec.footer || undefined, header: spec.header.type === 'none' ? { type: 'none' } : spec.header } } }).then(setRes).catch(() => undefined); }, 300);
    return () => clearTimeout(id);
  }, [spec]);

  const insert = (name: string) => {
    const el = bodyRef.current; const tok = `{{${name}}}`;
    if (!el) return setSpec({ body: spec.body + tok });
    const s = el.selectionStart ?? spec.body.length, e = el.selectionEnd ?? s;
    setSpec({ body: spec.body.slice(0, s) + tok + spec.body.slice(e) });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + tok.length, s + tok.length); });
  };
  const setButton = (i: number, p: any) => setSpec({ buttons: spec.buttons.map((b, j) => (j === i ? { ...b, ...p } : b)) });
  const addButton = (type: string) => setSpec({ buttons: [...spec.buttons, type === 'url' ? { type, text: 'View Quotation', url: defaultLink() } : type === 'phone' ? { type, text: 'Call us', phone: '' } : { type, text: 'Interested' }] });
  const uploadHeader = async (file: File) => {
    const form = new FormData(); form.append('file', file);
    const r = await run(() => api('/agency/whatsapp/templates/media/upload', { form }));
    if (r) setF((x) => ({ ...x, headerMediaAssetId: r.assetId, headerMediaUrl: r.url }));
  };

  const save = async () => {
    setServerIssues([]);
    const body = { name: f.name, language: f.language, category: f.category, headerMediaAssetId: f.spec.header.source === 'custom' ? f.headerMediaAssetId : null, spec: { ...spec, footer: spec.footer || undefined } };
    try {
      await (f.id ? api(`/agency/whatsapp/templates/${f.id}`, { method: 'PATCH', body }) : api('/agency/whatsapp/templates', { body }));
      onSaved();
    } catch (e: any) { setServerIssues(e.issues ?? [{ path: '', message: e.message }]); }
  };

  const issues = serverIssues.length ? serverIssues : res?.issues ?? [];
  const h = spec.header;
  const media: WaMedia | null = res?.headerMedia ? (h.source === 'custom' && f.headerMediaUrl ? { ...res.headerMedia, url: f.headerMediaUrl, missing: null } : res.headerMedia) : null;
  const used = (spec.body.match(/\{\{\s*[a-z0-9_]+\s*\}\}/g) ?? []).length;

  return (
    <Modal title={f.id ? 'Edit template' : 'New WhatsApp template'} onClose={onClose}>
      <div className="grid2">
        <div className="stack">
          <div className="fields">
            <Field label="Template name (lowercase_underscores)"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} placeholder="premium_quotation" disabled={!!f.id && false} /></Field>
            <Field label="Purpose"><select value={spec.purpose} onChange={(e) => setSpec({ purpose: e.target.value })}>{PURPOSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Category"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="UTILITY">Utility (quotations, updates)</option><option value="MARKETING">Marketing (promotions)</option></select></Field>
            <Field label="Language"><select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}><option value="en">English</option><option value="en_US">English (US)</option><option value="hi">Hindi</option><option value="kn">Kannada</option><option value="ta">Tamil</option><option value="te">Telugu</option><option value="ml">Malayalam</option></select></Field>
          </div>

          <fieldset className="card stack"><legend className="small muted">Header</legend>
            <div className="fields">
              <Field label="Type"><select value={h.type} onChange={(e) => setSpec({ header: e.target.value === 'none' ? { type: 'none' } : e.target.value === 'text' ? { type: 'text', text: h.text ?? '' } : e.target.value === 'image' ? { type: 'image', source: 'vehicle_photo' } : { type: 'document', source: 'quote_pdf' } })}><option value="none">None</option><option value="text">Text</option><option value="image">Image</option><option value="document">Document (quotation PDF)</option></select></Field>
              {h.type === 'image' && <Field label="Image from"><select value={h.source} onChange={(e) => setSpec({ header: { type: 'image', source: e.target.value } })}><option value="vehicle_photo">Vehicle photo (chosen when sending)</option><option value="logo">Agency logo</option><option value="custom">Upload an image</option></select></Field>}
            </div>
            {h.type === 'text' && <Field label={`Header text (${(h.text ?? '').length}/60)`}><input value={h.text ?? ''} maxLength={60} onChange={(e) => setSpec({ header: { type: 'text', text: e.target.value } })} /></Field>}
            {h.type === 'image' && h.source === 'custom' && <div className="row">{f.headerMediaUrl && <img src={f.headerMediaUrl} alt="Header" style={{ height: 48, borderRadius: 6 }} />}<label className="btn sm">Choose JPEG/PNG<input hidden type="file" accept="image/jpeg,image/png" onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadHeader(file); e.target.value = ''; }} /></label>{f.headerMediaAssetId && !f.headerMediaUrl && <span className="small muted">Image on file</span>}</div>}
            {h.type === 'document' && <div className="small muted">The quotation PDF is attached to the message as its header when you send a quotation.</div>}
          </fieldset>

          <Field label={`Message body (${spec.body.length}/1024)`}><textarea ref={bodyRef} rows={9} value={spec.body} onChange={(e) => setSpec({ body: e.target.value })} /></Field>
          <div><div className="small muted" style={{ marginBottom: 4 }}>Click to insert a variable ({used} used):</div>
            <div className="chips">{vars?.map((v) => <button type="button" key={v.name} className="chip" title={`Example: ${v.sample}`} onClick={() => insert(v.name)}>{`{{${v.name}}}`}</button>)}</div></div>
          <Field label={`Footer (${(spec.footer ?? '').length}/60, no variables)`}><input value={spec.footer ?? ''} maxLength={60} onChange={(e) => setSpec({ footer: e.target.value })} placeholder="Golden Travels | +91 98450 12345" /></Field>

          <fieldset className="card stack"><legend className="small muted">Buttons ({spec.buttons.length}/10)</legend>
            {spec.buttons.map((b, i) => (
              <div className="row" key={i} style={{ alignItems: 'flex-end' }}>
                <Field label={b.type === 'url' ? 'Link button' : b.type === 'phone' ? 'Call button' : 'Quick reply'}><input value={b.text} maxLength={25} onChange={(e) => setButton(i, { text: e.target.value })} /></Field>
                {b.type === 'url' && <Field label="Link (https, may end with {{quote_token}})"><input value={b.url} onChange={(e) => setButton(i, { url: e.target.value })} /></Field>}
                {b.type === 'phone' && <Field label="Phone (+91…)"><input value={b.phone} onChange={(e) => setButton(i, { phone: e.target.value })} /></Field>}
                <button className="btn sm danger" onClick={() => setSpec({ buttons: spec.buttons.filter((_, j) => j !== i) })} aria-label="Remove button">✕</button>
              </div>
            ))}
            <div className="row"><button className="btn sm" onClick={() => addButton('quick_reply')}>+ Quick reply</button><button className="btn sm" onClick={() => addButton('url')}>+ Link</button><button className="btn sm" onClick={() => addButton('phone')}>+ Call</button></div>
          </fieldset>
        </div>

        <div className="stack">
          <h3 style={{ margin: 0 }}>Live preview</h3>
          <div className="small muted">Sample customer data with your real agency details.</div>
          {res ? <WaPreview preview={res.preview as WaPreviewData} media={media} /> : <Loading />}
          {issues.length > 0 && <div className="banner err small stack" role="alert">{issues.map((x: any, i: number) => <div key={i}>{x.path ? <strong>{x.path}: </strong> : null}{x.message}</div>)}</div>}
          {(res?.warnings?.length ?? 0) > 0 && <div className="banner warn small stack">{res.warnings.map((x: any, i: number) => <div key={i}>{x.message}</div>)}</div>}
          <div className="small muted">Saving keeps this as a <strong>local draft</strong>. It reaches Meta only when you press <em>Submit to Meta</em>, and can be used only after Meta approves it.</div>
          <div className="row"><button className="btn primary" disabled={!f.name || !spec.body} onClick={save}>{f.id ? 'Save changes' : 'Save draft'}</button><button className="btn" onClick={onClose}>Cancel</button></div>
        </div>
      </div>
    </Modal>
  );
}
