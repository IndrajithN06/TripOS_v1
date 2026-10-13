'use client';
import { useEffect, useState } from 'react';
import { api, useApi } from '@/lib/api';
import { fmtDateTime, inr } from '@/lib/format';
import { ErrorBox, Loading, Modal, SimTag, StatusBadge, useAction, useMe } from '@/components/ui';
import { WaPreview } from '@/components/WaPreview';

const KIND: Record<string, string> = { template: 'WhatsApp template message', text: 'Message', pdf: 'Quotation PDF', image: 'Vehicle photo' };

/**
 * "Send Quotation on WhatsApp": pick an approved template, see exactly what the customer will receive, confirm the price for a
 * revised version, send. Delivery is reported per item (template message, PDF, photos) with the provider's outcome.
 */
export function SendQuoteModal({ quoteId, versionNumber, onClose, onSent }: { quoteId: string; versionNumber: number; onClose: () => void; onSent?: () => void }) {
  const me = useMe(), run = useAction();
  const { data: opts, error, reload } = useApi<any>(`/quotes/${quoteId}/versions/${versionNumber}/templates`);
  const [templateId, setTemplateId] = useState('');
  const [includePdf, setIncludePdf] = useState(true), [approved, setApproved] = useState(false), [busy, setBusy] = useState(false);
  const [prev, setPrev] = useState<any>(null), [prevErr, setPrevErr] = useState<any>(null), [result, setResult] = useState<any>(null);
  const tz = me.agency?.timezone;

  useEffect(() => { if (opts && !templateId && opts.recommendedTemplateId) setTemplateId(opts.recommendedTemplateId); }, [opts, templateId]);
  useEffect(() => {
    if (!templateId) { setPrev(null); return; }
    setPrev(null); setPrevErr(null);
    api('/agency/whatsapp/templates/preview', { body: { templateId, quoteId, versionNumber } }).then(setPrev).catch(setPrevErr);
  }, [templateId, quoteId, versionNumber]);

  if (error) return <Modal title="Send on WhatsApp" onClose={onClose}><ErrorBox e={error} retry={reload} /></Modal>;
  if (!opts) return <Modal title="Send on WhatsApp" onClose={onClose}><Loading /></Modal>;

  const tpl = opts.templates.find((t: any) => t.id === templateId);
  const needsDoc = tpl?.spec?.header?.type === 'document';
  const blockedByPrice = opts.requiresPriceApproval && !approved;
  const missing: string[] = prev?.preview?.missing ?? [];
  const send = async () => {
    setBusy(true);
    const r = await run(() => api(`/quotes/${quoteId}/versions/${versionNumber}/send-template`, { body: { templateId, includePdf: needsDoc ? false : includePdf, approvedTotal: opts.requiresPriceApproval ? opts.currentTotal : undefined } }));
    setBusy(false);
    if (r) { setResult(r); onSent?.(); }
  };
  const retry = async () => {
    setBusy(true);
    const r = await run(() => api(`/quotes/${quoteId}/versions/${versionNumber}/retry`, { body: {} }));
    setBusy(false);
    if (r) { setResult({ ...r, deferred: result?.deferred ?? null }); onSent?.(); }
  };

  if (result) {
    return (
      <Modal title="Delivery" narrow onClose={onClose}>
        <div className="stack">
          <div className="row"><StatusBadge s={result.versionStatus} /><span className="small muted">version {result.versionNumber}</span>{me.environment.whatsappSimulated && <SimTag />}</div>
          {result.attempts.map((a: any, i: number) => <div className="row between small" key={i}><span>{KIND[a.kind] ?? a.kind}</span><StatusBadge s={a.status} /></div>)}
          {result.attempts.some((a: any) => a.error) && <div className="banner err small">{result.attempts.find((a: any) => a.error)?.error}</div>}
          {result.deferred && <div className="banner warn small">{result.deferred.reason}</div>}
          <div className="small muted">&quot;Sent&quot; means WhatsApp accepted the message. Delivered / read arrive later from WhatsApp and show in the inbox. The customer accepting the quotation is tracked separately.</div>
          <div className="row">{result.versionStatus !== 'sent' && <button className="btn blue" disabled={busy} onClick={retry}>Retry failed items only</button>}<button className="btn" onClick={onClose}>Close</button></div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Send quotation ${versionNumber > 1 ? `(revised v${versionNumber}) ` : ''}on WhatsApp`} onClose={onClose}>
      {opts.templates.length === 0 ? (
        <div className="banner warn stack"><div><strong>No approved quotation template yet.</strong> WhatsApp only lets businesses start or re-open a conversation with an approved template.</div><div className="small">Ask an admin to create one in Settings → WhatsApp Templates and submit it to Meta. Meanwhile you can send plain messages if the customer wrote to you in the last 24 hours.</div></div>
      ) : (
        <div className="grid2">
          <div className="stack">
            <label>Template<select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>{opts.templates.map((t: any) => <option key={t.id} value={t.id}>{t.name} — {t.purposeLabel}</option>)}</select></label>
            {opts.requiresPriceApproval && (
              <div className="banner warn stack" role="group" aria-label="Revised price approval">
                <div><strong>Revised price</strong></div>
                <div className="row"><span className="muted">Previous</span><span className="mono">{inr(opts.previousTotal)}</span><span>→</span><span className="muted">New</span><strong className="mono">{inr(opts.currentTotal)}</strong></div>
                <label className="inline"><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />I approve sending this revised price of {inr(opts.currentTotal)} to the customer</label>
              </div>
            )}
            {!needsDoc && <label className="inline"><input type="checkbox" checked={includePdf} onChange={(e) => setIncludePdf(e.target.checked)} />Also send the quotation PDF</label>}
            <div className={`banner small ${opts.windowOpen ? 'ok' : 'warn'}`}>{opts.windowOpen ? 'The customer wrote within the last 24 hours: the PDF and vehicle photos follow the message.' : 'The 24-hour window is closed: only the template message can be sent now. The PDF and photos can follow once the customer replies.'}</div>
            {prevErr && <ErrorBox e={prevErr} />}
            {missing.length > 0 && <div className="banner err small">Cannot send yet. Missing: {missing.join(', ')}</div>}
            {me.environment.whatsappSimulated && <div className="small"><SimTag /> Goes to the local simulator only.</div>}
            <div className="row">
              <button className="btn primary" disabled={busy || !templateId || blockedByPrice || missing.length > 0 || !!prevErr} onClick={send}>{busy ? 'Sending…' : 'Send on WhatsApp'}</button>
              <button className="btn" onClick={onClose}>Cancel</button>
            </div>
            <div className="small muted">{tz ? `Times shown in ${tz}. ` : ''}{prev ? '' : null}</div>
          </div>
          <div className="stack">
            <h3 style={{ margin: 0 }}>What the customer receives</h3>
            {prev ? <WaPreview preview={prev.preview} media={prev.headerMedia} /> : prevErr ? null : <Loading />}
            {prev && versionNumber >= 1 && <div className="small muted">Quotation {prev.values?.quote_number ?? ''} · {prev.values?.quote_total ?? ''}{prev.values?.valid_until ? ` · valid until ${prev.values.valid_until}` : ''}</div>}
          </div>
        </div>
      )}
    </Modal>
  );
}
