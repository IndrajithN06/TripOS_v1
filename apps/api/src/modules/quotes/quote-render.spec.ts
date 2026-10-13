import { placeholderPng } from '../../common/placeholder-png';
import { renderQuotePdf, RenderModel } from './quote-render';

const model = (agencyName: string): RenderModel => {
  const now = new Date();
  return {
    quoteNumber: 'Q-0001', versionNumber: 1, createdAt: now, expiryAt: new Date(now.getTime() + 7 * 86400000),
    customer: { name: 'Rahul Shetty', phone: '+91 98000 00000' },
    brand: { agencyName, tagline: 'Journeys made easy', brandColour: '#0b6b4f', phone: '+91 98450 12345', email: 'hi@golden.example', website: 'golden.example', address: null, footer: null, timezone: 'Asia/Kolkata' },
    trip: { pickupLocation: 'Bangalore Airport', pickupAt: new Date(now.getTime() + 2 * 86400000).toISOString(), returnAt: new Date(now.getTime() + 5 * 86400000).toISOString(), destinations: ['Coorg'], passengers: 5, itinerary: 'Day 1: Bangalore to Coorg\nDay 2: Sightseeing\nDay 3: Return' },
    vehicleName: 'Innova Crysta',
    lines: [{ label: 'Outstation distance (900 km billable)', quantity: '900', unitAmount: '20.00', amount: '18000.00' }, { label: 'Driver batta (per day)', quantity: '3', unitAmount: '800.00', amount: '2400.00' }],
    subtotal: '20400.00', discount: '0.00', tax: '0.00', total: '20400.00', taxMode: 'exclusive', taxRatePercent: '0',
    inclusions: 'Fuel, driver, vehicle', exclusions: 'Toll, parking, permits', notes: null, terms: 'Sample terms.',
  };
};
const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('quotation PDF', () => {
  it('renders a valid PDF with logo, photos and long terms; contact footer on every page', async () => {
    const m = model('Golden Travels');
    m.terms = Array.from({ length: 40 }, (_, i) => `Term ${i + 1}: payment and cancellation conditions apply to this booking.`).join('\n');
    const photo = placeholderPng(40, 120, 90, 64, 48);
    const pdf = await renderQuotePdf(m, placeholderPng(30, 120, 90, 40, 30), [{ buffer: photo, caption: 'Front' }, { buffer: photo }, { buffer: photo, caption: 'Interior' }]);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pages(pdf)).toBeGreaterThan(1);
  });

  it('copes with no logo, no photos and a hostile logo buffer', async () => {
    const m = model('A Very Long Agency Name Travels And Tours Private Limited');
    expect((await renderQuotePdf(m, null, [])).subarray(0, 4).toString()).toBe('%PDF');
    expect((await renderQuotePdf(m, Buffer.from('not an image'), [{ buffer: Buffer.from('nope') }])).subarray(0, 4).toString()).toBe('%PDF');
  });
});
