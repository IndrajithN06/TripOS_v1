'use client';
import { fmtDateTime, inr } from '@/lib/format';

/**
 * Customer-facing quotation: white page, agency logo and name, one brand colour, a large total, an aligned price table, a photo
 * grid, inclusions / exclusions / terms and a contact footer. Mirrors the generated PDF; also used on the public quote link.
 */
export function QuotePreview({ p, hidePhone }: { p: any; hidePhone?: boolean }) {
  const tz = p.brand.timezone;
  const t = p.trip;
  const colour = p.brand.brandColour;
  const contact = [p.brand.phone, p.brand.email, p.brand.website].filter(Boolean);
  const rows: [string, string][] = [['Vehicle', p.vehicleName], ['Pickup', `${t.pickupLocation ?? '—'} · ${fmtDateTime(t.pickupAt, tz)}`]];
  if (t.returnAt) rows.push(['Return', fmtDateTime(t.returnAt, tz)]);
  rows.push(['Destination', (t.destinations ?? []).join(', ') || '—'], ['Passengers', String(t.passengers ?? '—')]);
  const list = (s: string) => s.split(/\r?\n/).filter((x) => x.trim());
  const section = (title: string, body?: string | null) => body && body.trim() ? <div className="qd-sec"><div className="qd-h" style={{ color: colour }}>{title}</div><ul>{list(body).map((x, i) => <li key={i}>{x.replace(/^[-•*]\s*/, '')}</li>)}</ul></div> : null;
  return (
    <div className="qdoc">
      <div className="qd-top">
        <div className="qd-brand">
          {p.logoUrl && <img src={p.logoUrl} alt={`${p.brand.agencyName} logo`} />}
          <div><div className="qd-name">{p.brand.agencyName}</div>{p.brand.tagline && <div className="qd-tag">{p.brand.tagline}</div>}</div>
        </div>
        <div className="qd-ref"><strong style={{ color: colour }}>{p.quoteNumber}</strong><span>Version {p.versionNumber}</span></div>
      </div>
      <div className="qd-for">Quotation for</div>
      <div className="qd-cust">{p.customer.name}{!hidePhone && p.customer.phone ? <span> · {p.customer.phone}</span> : null}</div>
      <div className="qd-total-l">Total amount</div>
      <div className="qd-total" style={{ color: colour }}>{inr(p.total)}</div>
      <div className="qd-sub">{[Number(p.tax) > 0 && p.taxMode === 'inclusive' ? 'Inclusive of taxes' : null, p.expiryAt ? `Valid until ${fmtDateTime(p.expiryAt, tz)}` : null].filter(Boolean).join(' · ')}</div>
      <dl className="qd-kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}{t.itinerary && <div><dt>Itinerary</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{t.itinerary}</dd></div>}</dl>
      <table className="qd-table"><thead><tr><th>Description</th><th>Amount</th></tr></thead><tbody>
        {p.lines.map((l: any, i: number) => <tr key={i}><td>{l.label}</td><td>{inr(l.amount)}</td></tr>)}
        <tr className="sum"><td>Subtotal</td><td>{inr(p.subtotal)}</td></tr>
        {Number(p.discount) > 0 && <tr className="sum"><td>Discount</td><td>− {inr(p.discount)}</td></tr>}
        {Number(p.tax) > 0 && <tr className="sum"><td>{p.taxMode === 'inclusive' ? 'Includes tax' : 'Tax'} ({p.taxRatePercent}%)</td><td>{inr(p.tax)}</td></tr>}
        <tr className="grand" style={{ borderColor: colour }}><td>Total</td><td style={{ color: colour }}>{inr(p.total)}</td></tr>
      </tbody></table>
      {p.photos?.length > 0 && <div className="qd-photos">{p.photos.map((ph: any, i: number) => <figure key={ph.assetId ?? i}><img src={ph.url} alt={`${p.vehicleName} photo ${i + 1}`} />{ph.caption && <figcaption>{ph.caption}</figcaption>}</figure>)}</div>}
      {section('Inclusions', p.inclusions)}{section('Exclusions', p.exclusions)}{section('Notes', p.notes)}{section('Terms & conditions', p.terms)}
      <div className="qd-foot"><strong>{p.brand.agencyName}</strong><div>{p.brand.footer || contact.join('  |  ')}</div>{p.brand.footer && contact.length > 0 && <div>{contact.join('  |  ')}</div>}</div>
    </div>
  );
}
