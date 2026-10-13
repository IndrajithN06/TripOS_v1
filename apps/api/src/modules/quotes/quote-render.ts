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

/**
 * Premium minimal quotation: white page, agency logo and name at the top, ONE brand colour, a large total, an aligned price
 * table, a vehicle photo grid, inclusions / exclusions / terms and the agency contact line on every page.
 * A5 portrait so it reads comfortably on a phone without zooming. Always the agency identity, never TripOS.
 */
export function renderQuotePdf(m: RenderModel, logo: Buffer | null, photos: RenderImage[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const M = 30, FOOT = 46;
    const doc = new PDFDocument({ size: 'A5', margin: M, bufferPages: true, info: { Title: `Quotation ${m.quoteNumber} v${m.versionNumber}`, Author: m.brand.agencyName } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const colour = /^#[0-9a-f]{6}$/i.test(m.brand.brandColour) ? m.brand.brandColour : '#157f58';
    const INK = '#182230', MUTED = '#6b7686', RULE = '#e7ebf1';
    const W = doc.page.width - M * 2, LIMIT = doc.page.height - FOOT - 8;
    let y = M;
    const ensure = (h: number) => { if (y + h > LIMIT) { doc.addPage(); y = M; } };
    const rule = (yy: number, x1 = M, x2 = M + W, c = RULE, w = 0.6) => { doc.moveTo(x1, yy).lineTo(x2, yy).lineWidth(w).strokeColor(c).stroke(); };
    const tz = m.brand.timezone;
    const t = m.trip;

    // ---- header: logo + agency name, quotation reference on the right
    let x = M;
    if (logo) { try { doc.image(logo, M, y, { fit: [96, 36] }); x = M + 106; } catch { /* unreadable logo: name only */ } }
    doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(m.brand.agencyName, x, y + 2, { width: W - (x - M) - 90, lineBreak: false, ellipsis: true });
    if (m.brand.tagline) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(m.brand.tagline, x, y + 20, { width: W - (x - M) - 90, lineBreak: false, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(colour).text(m.quoteNumber, M, y + 2, { width: W, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`Version ${m.versionNumber}`, M, y + 15, { width: W, align: 'right', lineBreak: false });
    y += 50;
    rule(y); y += 16;

    // ---- who it is for + the big total
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('QUOTATION FOR', M, y); y += 11;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(m.customer.name, M, y, { width: W }); y += 22;
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('TOTAL AMOUNT', M, y); y += 11;
    doc.font('Helvetica-Bold').fontSize(26).fillColor(colour).text(inr(m.total), M, y, { width: W, lineBreak: false }); y += 34;
    const sub = [Number(m.tax) > 0 && m.taxMode === 'inclusive' ? 'Inclusive of taxes' : null, m.expiryAt ? `Valid until ${fmtDate(m.expiryAt, tz)}` : null].filter(Boolean).join('  ·  ');
    if (sub) { doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(sub, M, y, { width: W }); y += 16; }
    y += 6;

    // ---- trip details (label / value pairs)
    const kv = (k: string, v: string) => {
      const h = Math.max(13, doc.font('Helvetica').fontSize(9).heightOfString(v, { width: W - 84 }) + 3);
      ensure(h);
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(k, M, y + 1, { width: 78, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(v, M + 84, y, { width: W - 84 });
      y += h;
    };
    kv('Vehicle', m.vehicleName);
    kv('Pickup', `${t.pickupLocation ?? '—'}  ·  ${fmtDate(t.pickupAt, tz)}`);
    if (t.returnAt) kv('Return', fmtDate(t.returnAt, tz));
    kv('Destination', (t.destinations ?? []).join(', ') || '—');
    kv('Passengers', String(t.passengers ?? '—'));
    if (t.itinerary) kv('Itinerary', String(t.itinerary));
    y += 12;

    // ---- price table: description on the left, amounts right-aligned in one column
    const AMT = 84;
    ensure(40);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('DESCRIPTION', M, y, { width: W - AMT - 8, lineBreak: false }).text('AMOUNT', M + W - AMT, y, { width: AMT, align: 'right', lineBreak: false });
    y += 12; rule(y); y += 6;
    for (const l of m.lines) {
      const h = Math.max(15, doc.font('Helvetica').fontSize(9).heightOfString(l.label, { width: W - AMT - 8 }) + 5);
      ensure(h);
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(l.label, M, y, { width: W - AMT - 8 }).text(inr(l.amount), M + W - AMT, y, { width: AMT, align: 'right', lineBreak: false });
      y += h;
    }
    y += 2; rule(y); y += 8;
    const sumRow = (k: string, v: string) => { ensure(14); doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(k, M, y, { width: W - AMT - 8, align: 'right', lineBreak: false }); doc.fillColor(INK).text(v, M + W - AMT, y, { width: AMT, align: 'right', lineBreak: false }); y += 14; };
    sumRow('Subtotal', inr(m.subtotal));
    if (Number(m.discount) > 0) sumRow('Discount', `- ${inr(m.discount)}`);
    if (Number(m.tax) > 0) sumRow(m.taxMode === 'inclusive' ? `Includes tax (${m.taxRatePercent}%)` : `Tax (${m.taxRatePercent}%)`, inr(m.tax));
    ensure(28);
    rule(y + 2, M + W - 190, M + W, colour, 1); y += 9;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Total', M, y, { width: W - AMT - 38, align: 'right', lineBreak: false }).fillColor(colour).text(inr(m.total), M + W - AMT - 30, y, { width: AMT + 30, align: 'right', lineBreak: false });
    y += 26;

    // ---- vehicle photos (2-up grid)
    if (photos.length) {
      const gap = 8, cw = (W - gap) / 2, ch = Math.round(cw * 0.68);
      ensure(24 + ch);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(colour).text(m.vehicleName.toUpperCase(), M, y, { lineBreak: false }); y += 14;
      photos.forEach((p, i) => {
        const col = i % 2;
        if (col === 0) ensure(ch + 22);
        const px = M + col * (cw + gap);
        try { doc.save(); doc.roundedRect(px, y, cw, ch, 4).clip(); doc.image(p.buffer, px, y, { cover: [cw, ch], align: 'center', valign: 'center' }); doc.restore(); }
        catch { doc.restore(); doc.roundedRect(px, y, cw, ch, 4).lineWidth(0.6).strokeColor(RULE).stroke(); }
        if (p.caption) doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(p.caption, px, y + ch + 3, { width: cw, lineBreak: false, ellipsis: true });
        if (col === 1 || i === photos.length - 1) y += ch + 20;
      });
      y += 4;
    }

    // ---- inclusions / exclusions / notes / terms
    const block = (title: string, body?: string | null) => {
      if (!body?.trim()) return;
      ensure(30);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(colour).text(title.toUpperCase(), M, y, { lineBreak: false }); y += 12;
      for (const line of body.split(/\r?\n/).filter((s) => s.trim())) {
        const h = doc.font('Helvetica').fontSize(8.5).heightOfString(line, { width: W }) + 3;
        ensure(h);
        doc.fillColor(INK).text(line, M, y, { width: W }); y += h;
      }
      y += 8;
    };
    block('Inclusions', m.inclusions); block('Exclusions', m.exclusions); block('Notes', m.notes); block('Terms & conditions', m.terms);

    // ---- contact footer on every page
    const foot = [m.brand.phone, m.brand.email, m.brand.website].filter(Boolean).join('   |   ');
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const fy = doc.page.height - FOOT + 8;
      rule(fy - 6);
      doc.page.margins.bottom = 0;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK).text(m.brand.agencyName, M, fy, { width: W, align: 'center', lineBreak: false });
      doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(m.brand.footer || foot || m.brand.address || '', M, fy + 10, { width: W, align: 'center', lineBreak: false, ellipsis: true });
      if (m.brand.footer && foot) doc.text(foot, M, fy + 19, { width: W, align: 'center', lineBreak: false, ellipsis: true });
    }
    doc.end();
  });
}
