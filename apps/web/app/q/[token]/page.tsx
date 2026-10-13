'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { QuotePreview } from '@/components/QuotePreview';

/** The page a customer opens from the WhatsApp message. No login; the unguessable link is the authorisation. Mobile-first. */
export default function PublicQuote() {
  const { token } = useParams<{ token: string }>();
  const [v, setV] = useState<any>(null), [err, setErr] = useState<ApiError | null>(null);
  useEffect(() => { api(`/public/quotes/${token}`).then(setV).catch(setErr); }, [token]);

  if (err) return <main className="pq"><div className="pq-card"><h1>Quotation not found</h1><p>This link is not valid or is no longer available. Please contact your travel agency for a new one.</p></div></main>;
  if (!v) return <main className="pq"><div className="pq-card" role="status">Loading your quotation…</div></main>;
  const p = { ...v.model, customer: { name: v.customerName, phone: '' }, logoUrl: v.logoUrl, photos: v.photos };
  const brand = v.model.brand;
  return (
    <main className="pq">
      {v.expired && <div className="pq-banner warn">This quotation has expired. Please contact {brand.agencyName} for an updated price.</div>}
      {!v.expired && v.superseded && <div className="pq-banner">A newer version of this quotation may be available. Please check your latest WhatsApp message from {brand.agencyName}.</div>}
      {v.expired ? <div className="pq-card"><h1>{brand.agencyName}</h1><p>Quotation {v.model.quoteNumber} is no longer valid.</p></div> : <QuotePreview p={p} hidePhone />}
      <div className="pq-actions">
        {v.pdfAvailable && <a className="pq-btn" href={`/api/public/quotes/${token}/pdf`} target="_blank" rel="noreferrer" style={{ background: brand.brandColour }}>Download PDF</a>}
        {brand.phone && <a className="pq-btn ghost" href={`tel:${brand.phone.replace(/[^+\d]/g, '')}`} style={{ color: brand.brandColour, borderColor: brand.brandColour }}>Call {brand.agencyName}</a>}
      </div>
      <p className="pq-note">To accept this quotation, reply to the WhatsApp message or contact {brand.agencyName}.</p>
    </main>
  );
}
