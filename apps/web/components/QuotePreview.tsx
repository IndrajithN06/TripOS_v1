'use client';
import { fmtDateTime, inr } from '@/lib/format';

/** Customer-facing preview: agency branding + selected photos. Mirrors the generated PDF. */
export function QuotePreview({ p }: { p: any }) {
  const tz = p.brand.timezone;
  const t = p.trip;
  return (
    <div className="preview">
      <div className="hd" style={{ background: p.brand.brandColour }}>
        {p.logoUrl && <img src={p.logoUrl} alt={`${p.brand.agencyName} logo`} />}
        <div><div style={{ fontWeight: 800, fontSize: 18 }}>{p.brand.agencyName}</div>{p.brand.tagline && <div style={{ opacity: .9, fontSize: 12 }}>{p.brand.tagline}</div>}</div>
      </div>
      <div className="bd">
        <div className="row between"><strong>Quotation {p.quoteNumber}</strong><span className="small" style={{ color: '#667487' }}>Version {p.versionNumber} · {fmtDateTime(p.createdAt, tz)}</span></div>
        <div className="small" style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 4 }}>
          <span style={{ color: '#667487' }}>Customer</span><span>{p.customer.name} ({p.customer.phone})</span>
          <span style={{ color: '#667487' }}>Vehicle</span><span>{p.vehicleName}</span>
          <span style={{ color: '#667487' }}>Pickup</span><span>{t.pickupLocation} · {fmtDateTime(t.pickupAt, tz)}</span>
          {t.returnAt && <><span style={{ color: '#667487' }}>Return</span><span>{fmtDateTime(t.returnAt, tz)}</span></>}
          <span style={{ color: '#667487' }}>Destination</span><span>{(t.destinations ?? []).join(', ') || '—'}</span>
          <span style={{ color: '#667487' }}>Passengers</span><span>{t.passengers}</span>
          {t.itinerary && <><span style={{ color: '#667487' }}>Itinerary</span><span style={{ whiteSpace: 'pre-wrap' }}>{t.itinerary}</span></>}
        </div>
        <table className="lines"><tbody>
          {p.lines.map((l: any, i: number) => <tr key={i}><td>{l.label}</td><td className="right mono">{inr(l.amount)}</td></tr>)}
          <tr><td className="muted">Subtotal</td><td className="right mono">{inr(p.subtotal)}</td></tr>
          {Number(p.discount) > 0 && <tr><td className="muted">Discount</td><td className="right mono">− {inr(p.discount)}</td></tr>}
          {Number(p.tax) > 0 && <tr><td className="muted">{p.taxMode === 'inclusive' ? 'Includes tax' : 'Tax'} ({p.taxRatePercent}%)</td><td className="right mono">{inr(p.tax)}</td></tr>}
          <tr className="total"><td>Total</td><td className="right mono">{inr(p.total)}</td></tr>
        </tbody></table>
        {p.inclusions && <div className="small"><strong>Inclusions:</strong> {p.inclusions}</div>}
        {p.exclusions && <div className="small"><strong>Exclusions:</strong> {p.exclusions}</div>}
        {p.notes && <div className="small"><strong>Notes:</strong> {p.notes}</div>}
        {p.photos?.length > 0 && <div className="photos">{p.photos.map((ph: any) => <div key={ph.assetId} className="photo"><img src={ph.url} alt={`${p.vehicleName} photo`} /></div>)}</div>}
        {p.terms && <div className="small" style={{ color: '#667487' }}>{p.terms}</div>}
        <div className="small" style={{ color: '#667487', textAlign: 'center' }}>{p.brand.footer || [p.brand.phone, p.brand.email].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  );
}
