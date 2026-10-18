'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { inr } from '@/lib/format';
import { cleanReason, REASON_MAX } from '@/lib/quote-delete';
import { Modal, StatusBadge, errMsg, useToast } from './ui';

export interface DeletableQuote { id: string; quoteNumber: string; customer?: string | null; total?: string | null; status?: string | null }

/**
 * The one confirmation used everywhere a quote can be deleted (quote page, quotes list, inbox panel).
 * Deleting is a soft delete: the quote leaves the normal views, but messages, delivery status, versions, files and the audit
 * history are kept. The optional reason is stored in the audit log only.
 */
export function ConfirmDeleteQuote({ quote, onClose, onDeleted }: { quote: DeletableQuote; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false);

  async function remove() {
    if (busy) return; // a double click must not send two requests
    setBusy(true);
    try {
      const r = cleanReason(reason);
      await api(`/quotes/${quote.id}`, { method: 'DELETE', body: r ? { reason: r } : undefined });
      toast(`Quote ${quote.quoteNumber} removed`);
      onDeleted();
    } catch (e: any) {
      // Only the API's own "quote not found" means someone else already removed it. Any other failure (including a missing route) is shown as an error and nothing is assumed.
      if (e?.status === 404 && e?.code === 'not_found') { toast(`Quote ${quote.quoteNumber} was already removed`); onDeleted(); }
      else { toast(errMsg(e), true); setBusy(false); }
    }
  }

  return (
    <Modal title={`Delete quote ${quote.quoteNumber}?`} narrow onClose={busy ? () => undefined : onClose}>
      <div className="stack">
        <div className="qd-who">
          <strong>{quote.quoteNumber}</strong>
          {quote.customer && <span> · {quote.customer}</span>}
          {quote.total != null && quote.total !== '' && <span className="mono"> · {inr(quote.total)}</span>}
          {quote.status && <> <StatusBadge s={quote.status} /></>}
        </div>
        <p style={{ margin: 0 }}>This removes the quote from the quotes list, search and the customer panel. It is not permanently erased:</p>
        <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 2 }}>
          <li>Messages already sent to the customer, their delivery status and the version history are kept.</li>
          <li>The quote number is not reused.</li>
          <li><strong>The customer&apos;s quotation link and PDF page will stop working.</strong></li>
        </ul>
        <label>Reason (optional, kept in the audit log)
          <textarea rows={2} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong dates, created by mistake" disabled={busy} />
        </label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn danger-solid" onClick={remove} disabled={busy}>{busy ? 'Deleting…' : 'Delete quote'}</button>
        </div>
      </div>
    </Modal>
  );
}
