'use client';
import { useEffect, useMemo, useState } from 'react';
import { api, useApi } from '@/lib/api';
import { ErrorBox, Field, Loading, Modal, SimTag, StatusBadge, useAction, useMe } from '@/components/ui';
import { WaPreview } from '@/components/WaPreview';

/**
 * Inbox "Templates": choose an approved template, see it filled with this customer's data in a WhatsApp-style preview, edit
 * any value, optionally attach a quotation and vehicle photos, then send. Missing values block the send (nothing goes out blank).
 */
export function InboxTemplateModal({ conversationId, quotes, windowOpen, onClose, onSent }: { conversationId: string; quotes: { id: string; quoteNumber: string; status: string }[]; windowOpen: boolean; onClose: () => void; onSent: () => void }) {
  const me = useMe(), run = useAction();
  const { data: templates, error } = useApi<any[]>('/agency/whatsapp/templates?status=approved');
  const [templateId, setTemplateId] = useState(''), [quoteId, setQuoteId] = useState(quotes[0]?.id ?? '');
  const [edits, setEdits] = useState<Record<string, string>>({}), [photoIds, setPhotoIds] = useState<string[]>([]), [headerId, setHeaderId] = useState('');
  const [quote, setQuote] = useState<any>(null), [qPreview, setQPreview] = useState<any>(null);
  const [prev, setPrev] = useState<any>(null), [prevErr, setPrevErr] = useState<any>(null), [busy, setBusy] = useState(false), [result, setResult] = useState<any>(null);

  const tpl = templates?.find((t) => t.id === templateId);
  useEffect(() => { if (templates && !templateId && templates[0]) setTemplateId(templates[0].id); }, [templates, templateId]);

  // the selected quotation (current version) and its photos
  useEffect(() => {
    setQuote(null); setQPreview(null); setPhotoIds([]); setHeaderId('');
    if (!quoteId) return;
    api(`/quotes/${quoteId}`).then(async (q) => {
      const cur = q.versions.find((v: any) => v.id === q.currentVersionId);
      setQuote({ ...q, cur });
      try { const p = await api(`/quotes/${quoteId}/versions/${cur.versionNumber}/preview`); setQPreview(p); setPhotoIds((p.photos ?? []).map((x: any) => x.assetId)); } catch { /* preview optional */ }
    }).catch(() => undefined);
  }, [quoteId]);

  const versionNumber = quote?.cur?.versionNumber as number | undefined;
  const editKey = JSON.stringify(edits);
  useEffect(() => {
    if (!templateId) return;
    setPrevErr(null);
    const id = setTimeout(() => {
      api('/agency/whatsapp/templates/preview', { body: { templateId, conversationId, quoteId: quoteId && versionNumber ? quoteId : undefined, versionNumber: quoteId ? versionNumber : undefined, values: edits } })
        .then((r) => { setPrev(r); setPrevErr(null); }).catch(setPrevErr);
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, conversationId, quoteId, versionNumber, editKey]);

  const fields = useMemo(() => (tpl ? (tpl.required as string[]).filter((n) => !['quote_token', 'quote_link'].includes(n)) : []), [tpl]);
  const missing: string[] = prev?.preview?.missing ?? [];
  const needsPhotoHeader = tpl?.spec?.header?.type === 'image' && tpl?.spec?.header?.source === 'vehicle_photo';
  const needsLink = !!tpl && (tpl.required as string[]).some((n) => n === 'quote_token' || n === 'quote_link');
  const unsentQuote = quote && !quote.cur?.immutable;
  const photos: any[] = qPreview?.photos ?? [];
  const toggle = (id: string) => setPhotoIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // The header photo is already part of the template message: do not send it a second time as a separate photo.
  const headerAsset = needsPhotoHeader ? (headerId || photoIds[0]) || undefined : undefined;
  const extraPhotos = photoIds.filter((id) => id !== headerAsset);
  const send = async () => {
    setBusy(true);
    const r = await run(() => api(`/inbox/conversations/${conversationId}/messages`, { body: {
      type: 'template', templateId, idempotencyKey: crypto.randomUUID(), values: edits,
      quoteId: quoteId || undefined, versionNumber: quoteId ? versionNumber : undefined,
      headerAssetId: headerAsset,
      photoAssetIds: windowOpen && extraPhotos.length ? extraPhotos : undefined,
    } }));
    setBusy(false);
    if (r) { setResult(r); onSent(); }
  };

  if (error) return <Modal title="Templates" onClose={onClose}><ErrorBox e={error} /></Modal>;
  if (!templates) return <Modal title="Templates" onClose={onClose}><Loading /></Modal>;

  if (result) {
    return (
      <Modal title="Template message" narrow onClose={onClose}>
        <div className="stack">
          <div className="row"><StatusBadge s={result.status} />{me.environment.whatsappSimulated && <SimTag />}</div>
          {result.ok ? <div className="small">Accepted by WhatsApp. Provider message ID: <span className="mono">{result.providerMessageId ?? result.messageId}</span></div> : <div className="banner err small">{result.errorMessage ?? 'The message was not accepted.'}</div>}
          {result.photos?.length > 0 && <div className="small">Photos: {result.photos.filter((p: any) => p.ok).length} sent, {result.photos.filter((p: any) => !p.ok).length} failed</div>}
          {result.photosSkipped && <div className="banner warn small">The 24-hour window is closed, so photos were not sent. Send them once the customer replies.</div>}
          <div className="small muted">Delivered / read updates appear on the message in the chat.</div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Send a WhatsApp template" onClose={onClose}>
      {templates.length === 0 ? (
        <div className="banner warn stack"><div><strong>No approved templates.</strong> An admin can create and submit one in Settings → WhatsApp Templates. Meta must approve it before it can be sent.</div></div>
      ) : (
        <div className="grid2">
          <div className="stack">
            <Field label="Template"><select value={templateId} onChange={(e) => { setTemplateId(e.target.value); setEdits({}); }}>{templates.map((t) => <option key={t.id} value={t.id}>{t.name} — {t.purposeLabel}</option>)}</select></Field>
            <Field label="Quotation to use (optional)"><select value={quoteId} onChange={(e) => setQuoteId(e.target.value)}><option value="">None</option>{quotes.map((q) => <option key={q.id} value={q.id}>{q.quoteNumber} ({q.status.replace(/_/g, ' ')})</option>)}</select></Field>
            {needsLink && unsentQuote && <div className="banner warn small">This template carries a quotation link, which exists only after a quotation is sent. Use <strong>Send Quotation on WhatsApp</strong> on the quote for first-time sending.</div>}
            {fields.length > 0 && <div className="stack"><div className="small muted">Values (filled from the customer and quotation; edit if needed)</div>
              {fields.map((n) => <Field key={n} label={n.replace(/_/g, ' ')}><input value={edits[n] ?? prev?.values?.[n] ?? ''} onChange={(e) => setEdits({ ...edits, [n]: e.target.value })} /></Field>)}</div>}
            {photos.length > 0 && (
              <div className="stack">
                <div className="small muted">{windowOpen ? 'Vehicle photos (sent right after the message)' : 'Vehicle photos (cannot be sent while the 24-hour window is closed)'}</div>
                <div className="photos">{photos.map((p: any) => <div key={p.assetId} className={`photo ${photoIds.includes(p.assetId) ? 'on' : ''}`} onClick={() => toggle(p.assetId)} role="checkbox" aria-checked={photoIds.includes(p.assetId)} aria-label="Vehicle photo"><img src={p.url} alt="Vehicle" /></div>)}</div>
                {needsPhotoHeader && photoIds.length > 1 && <Field label="Header photo"><select value={headerId || photoIds[0]} onChange={(e) => setHeaderId(e.target.value)}>{photoIds.map((id, i) => <option key={id} value={id}>Photo {i + 1}</option>)}</select></Field>}
              </div>
            )}
            {prevErr && <ErrorBox e={prevErr} />}
            {missing.length > 0 && <div className="banner err small">Cannot send yet. Missing: {missing.join(', ')}</div>}
            {me.environment.whatsappSimulated && <div className="small"><SimTag /> Goes to the local simulator only.</div>}
            <div className="row"><button className="btn primary" disabled={busy || !templateId || missing.length > 0 || !!prevErr} onClick={send}>{busy ? 'Sending…' : 'Send template'}</button><button className="btn" onClick={onClose}>Cancel</button></div>
          </div>
          <div className="stack">
            <h3 style={{ margin: 0 }}>Preview</h3>
            {prev ? <WaPreview preview={prev.preview} media={needsPhotoHeader && photoIds.length ? { kind: 'image', label: 'Vehicle photo', url: photos.find((p) => p.assetId === (headerId || photoIds[0]))?.url ?? null, missing: null } : prev.headerMedia} extraImages={windowOpen ? photos.filter((p) => extraPhotos.includes(p.assetId)).map((p) => p.url) : []} /> : prevErr ? null : <Loading />}
          </div>
        </div>
      )}
    </Modal>
  );
}
