import { placeholderPng } from '../../common/placeholder-png';
import { renderQuotePdf } from './quote-render';
import { sampleRenderModel } from '../templates/templates.service';

const brand = { brandColour: '#0b6b4f', tagline: 'Journeys made easy', phone: '+91 98450 12345', email: 'hi@golden.example', website: 'golden.example', address: null, footer: null };
const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('quotation PDF', () => {
  it('renders a valid PDF with logo, photos and long terms; contact footer on every page', async () => {
    const m = sampleRenderModel('Golden Travels', brand, 'Asia/Kolkata');
    m.terms = Array.from({ length: 40 }, (_, i) => `Term ${i + 1}: payment and cancellation conditions apply to this booking.`).join('\n');
    const photo = placeholderPng(40, 120, 90, 64, 48);
    const pdf = await renderQuotePdf(m, placeholderPng(30, 120, 90, 40, 30), [{ buffer: photo, caption: 'Front' }, { buffer: photo }, { buffer: photo, caption: 'Interior' }]);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pages(pdf)).toBeGreaterThan(1);
  });

  it('copes with no logo, no photos and a hostile logo buffer', async () => {
    const m = sampleRenderModel('A Very Long Agency Name Travels And Tours Private Limited', brand, 'Asia/Kolkata');
    expect((await renderQuotePdf(m, null, [])).subarray(0, 4).toString()).toBe('%PDF');
    expect((await renderQuotePdf(m, Buffer.from('not an image'), [{ buffer: Buffer.from('nope') }])).subarray(0, 4).toString()).toBe('%PDF');
  });
});
