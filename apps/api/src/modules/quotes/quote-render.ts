import PDFDocument from 'pdfkit';

export interface RenderImage { buffer: Buffer; caption?: string | null }
export interface RenderModel {
  quoteNumber: string;
  versionNumber: number;
  createdAt: Date;
  expiryAt: Date | null;
  customer: { name: string; phone: string };
  brand: { agencyName: string; tagline?: string | null; brandColour: string; phone?: string | null; email?: string | null; website?: string | null; address?: string | null; footer?: string | null; timezone: string };
  trip: any;
  vehicleName: string;
  lines: { label: string; quantity: string; unitAmount: string; amount: string }[];
  subtotal: string; discount: string; tax: string; total: string; taxMode: string; taxRatePercent: string;
  inclusions?: string | null; exclusions?: string | null; notes?: string | null; terms?: string | null;
}

export const inr = (v: string) => `INR ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function fmtDate(d: string | Date | null | undefined, tz: string) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(d));
}

/** Text sent in the WhatsApp message that accompanies the PDF. Uses the AGENCY identity, never TripOS. */
export function quoteMessageText(m: RenderModel) {
  const t = m.trip;
  return [
    `*${m.brand.agencyName}* — Quotation ${m.quoteNumber} (v${m.versionNumber})`,
    `Vehicle: ${m.vehicleName}`,
    t.pickupLocation ? `Pickup: ${t.pickupLocation}` : null,
    t.destinations?.length ? `Destination: ${t.destinations.join(', ')}` : null,
    t.pickupAt ? `Date: ${fmtDate(t.pickupAt, m.brand.timezone)}` : null,
    `*Total: ${inr(m.total)}*${m.taxMode === 'inclusive' && Number(m.tax) > 0 ? ' (incl. tax)' : ''}`,
    m.expiryAt ? `Valid until ${fmtDate(m.expiryAt, m.brand.timezone)}` : null,
    '',
    'Full details and vehicle photos are attached.',
    m.brand.phone ? `Call us: ${m.brand.phone}` : null,
  ].filter((x) => x !== null).join('\n');
}

export function renderQuotePdf(m: RenderModel, logo: Buffer | null, photos: RenderImage[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Quotation ${m.quoteNumber} v${m.versionNumber}`, Author: m.brand.agencyName } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const colour = /^#[0-9a-f]{6}$/i.test(m.brand.brandColour) ? m.brand.brandColour : '#157f58';
    const W = doc.page.width - 80;

    doc.rect(0, 0, doc.page.width, 90).fill(colour);
    let x = 40;
    if (logo) { try { doc.image(logo, 40, 20, { fit: [70, 50] }); x = 120; } catch { /* unreadable logo: fall back to text only */ } }
    doc.fillColor('#fff').fontSize(20).font('Helvetica-Bold').text(m.brand.agencyName, x, 28, { width: W - (x - 40) });
    if (m.brand.tagline) doc.fontSize(10).font('Helvetica').text(m.brand.tagline, x, 54, { width: W - (x - 40) });

    doc.fillColor('#182230').font('Helvetica-Bold').fontSize(14).text(`Quotation ${m.quoteNumber}`, 40, 110);
    doc.font('Helvetica').fontSize(9).fillColor('#778293')
      .text(`Version ${m.versionNumber}  ·  Issued ${fmtDate(m.createdAt, m.brand.timezone)}${m.expiryAt ? `  ·  Valid until ${fmtDate(m.expiryAt, m.brand.timezone)}` : ''}`, 40, 130);

    const kv = (k: string, v: string, y: number) => { doc.font('Helvetica-Bold').fontSize(9).fillColor('#778293').text(k, 40, y, { width: 110 }); doc.font('Helvetica').fillColor('#182230').text(v, 150, y, { width: W - 110 }); };
    let y = 156;
    const t = m.trip;
    for (const [k, v] of [
      ['Customer', `${m.customer.name} (${m.customer.phone})`], ['Vehicle', m.vehicleName],
      ['Pickup', `${t.pickupLocation ?? '—'}  ·  ${fmtDate(t.pickupAt, m.brand.timezone)}`],
      ['Return', t.returnAt ? fmtDate(t.returnAt, m.brand.timezone) : '—'],
      ['Destination', (t.destinations ?? []).join(', ') || '—'], ['Passengers', String(t.passengers ?? '—')],
    ] as [string, string][]) { kv(k, v, y); y += 16; }
    if (t.itinerary) { kv('Itinerary', String(t.itinerary), y); y += doc.heightOfString(String(t.itinerary), { width: W - 110 }) + 6; }

    y += 10;
    doc.rect(40, y, W, 20).fill('#f5f7fa');
    doc.fillColor('#182230').font('Helvetica-Bold').fontSize(9).text('Description', 48, y + 6).text('Qty', 340, y + 6, { width: 40, align: 'right' }).text('Rate', 385, y + 6, { width: 70, align: 'right' }).text('Amount', 460, y + 6, { width: 75, align: 'right' });
    y += 26;
    doc.font('Helvetica').fontSize(9);
    for (const l of m.lines) {
      doc.fillColor('#182230').text(l.label, 48, y, { width: 285 }).text(l.quantity, 340, y, { width: 40, align: 'right' }).text(inr(l.unitAmount), 385, y, { width: 70, align: 'right' }).text(inr(l.amount), 460, y, { width: 75, align: 'right' });
      y += Math.max(16, doc.heightOfString(l.label, { width: 285 }) + 4);
    }
    y += 6;
    const total = (k: string, v: string, bold = false) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 9).fillColor('#182230').text(k, 340, y, { width: 115, align: 'right' }).text(v, 460, y, { width: 75, align: 'right' }); y += bold ? 20 : 14; };
    total('Subtotal', inr(m.subtotal));
    if (Number(m.discount) > 0) total('Discount', `- ${inr(m.discount)}`);
    if (Number(m.tax) > 0) total(m.taxMode === 'inclusive' ? `Includes tax (${m.taxRatePercent}%)` : `Tax (${m.taxRatePercent}%)`, inr(m.tax));
    doc.moveTo(340, y).lineTo(535, y).strokeColor(colour).stroke(); y += 6;
    total('Total', inr(m.total), true);

    const block = (title: string, body?: string | null) => {
      if (!body) return;
      if (y > 700) { doc.addPage(); y = 40; }
      doc.font('Helvetica-Bold').fontSize(10).fillColor(colour).text(title, 40, y); y += 14;
      doc.font('Helvetica').fontSize(9).fillColor('#182230').text(body, 40, y, { width: W }); y += doc.heightOfString(body, { width: W }) + 10;
    };
    y += 8;
    block('Inclusions', m.inclusions); block('Exclusions', m.exclusions); block('Notes', m.notes); block('Terms & conditions', m.terms);

    if (photos.length) {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(12).fillColor(colour).text(`${m.vehicleName}`, 40, 40);
      const cw = (W - 12) / 2, ch = 190;
      photos.forEach((p, i) => {
        const col = i % 2, row = Math.floor(i / 2) % 3;
        if (i > 0 && i % 6 === 0) doc.addPage();
        const px = 40 + col * (cw + 12), py = 70 + row * (ch + 36);
        try { doc.image(p.buffer, px, py, { fit: [cw, ch], align: 'center', valign: 'center' }); } catch { doc.rect(px, py, cw, ch).stroke('#e7ebf1'); }
        if (p.caption) doc.font('Helvetica').fontSize(8).fillColor('#778293').text(p.caption, px, py + ch + 4, { width: cw });
      });
    }

    const foot = [m.brand.phone, m.brand.email, m.brand.website, m.brand.address].filter(Boolean).join('  ·  ');
    const range = doc.bufferedPageRange();
    void range;
    doc.font('Helvetica').fontSize(8).fillColor('#778293').text(m.brand.footer || foot || m.brand.agencyName, 40, doc.page.height - 50, { width: W, align: 'center', lineBreak: false });
    doc.end();
  });
}
