import { AUTO_FIELDS, cleanValue, getStarter, hasUnfilledPlaceholder, MAX_VALUE_LENGTH, placeholdersOf, renderStarter, STARTER_FIELDS, STARTERS } from './starter-messages';

const full: Record<string, string> = {
  customer_name: 'Rahul Shetty', agency_name: 'Golden Travels', quote_number: 'Q-0001', quote_total: '₹21,000.00', destination: 'Coorg',
  travel_dates: '13 Oct 2030 – 16 Oct 2030', duration: '3 days', pickup_location: 'Bangalore Airport', booking_reference: 'BK-77', departure_date: '13 Oct 2030', amount_due: '₹5,000',
};

describe('built-in message starters', () => {
  it('are exactly the five agreed, in order, with unique keys', () => {
    expect(STARTERS.map((s) => s.label)).toEqual(['Quotation Ready', 'Quote Follow-up', 'Booking Confirmation', 'Payment Reminder', 'Upcoming Trip Reminder']);
    expect(new Set(STARTERS.map((s) => s.key)).size).toBe(5);
  });

  it('only use placeholders that have a label', () => {
    for (const s of STARTERS) {
      for (const n of placeholdersOf(s.body)) expect(STARTER_FIELDS[n]).toBeDefined();
      expect(s.body.length).toBeLessThan(1024);
    }
  });

  it('render completely when every field has a value', () => {
    for (const s of STARTERS) {
      const r = renderStarter(s, full);
      expect(r.missing).toEqual([]);
      expect(hasUnfilledPlaceholder(r.text)).toBe(false);
      expect(r.text).toContain('Rahul Shetty');
    }
  });

  it('Quotation Ready carries the quotation facts', () => {
    const r = renderStarter(getStarter('quotation_ready')!, full);
    expect(r.text).toContain('Q-0001');
    expect(r.text).toContain('₹21,000.00');
    expect(r.text).toContain('Coorg');
    expect(r.text).toContain('3 days');
  });

  it('booking and payment fields are never auto-filled: V1 has no reliable source for them', () => {
    for (const manual of ['booking_reference', 'amount_due', 'departure_date']) expect(AUTO_FIELDS as readonly string[]).not.toContain(manual);
  });

  it('missing values stay visible as {{name}} and are listed, never guessed', () => {
    const r = renderStarter(getStarter('payment_reminder')!, { customer_name: 'Asha', agency_name: 'Golden Travels' });
    expect(r.missing.sort()).toEqual(['amount_due', 'booking_reference']);
    expect(r.text).toContain('{{amount_due}}');
    expect(r.text).toContain('{{booking_reference}}');
    expect(hasUnfilledPlaceholder(r.text)).toBe(true);
  });

  it('blank, whitespace-only and non-string values count as missing', () => {
    const r = renderStarter(getStarter('quote_followup')!, { customer_name: '   ', agency_name: 5, quote_number: null, destination: undefined });
    expect(r.missing.sort()).toEqual(['agency_name', 'customer_name', 'destination', 'quote_number']);
  });

  it('a value is inserted literally and never re-scanned: it cannot inject another placeholder', () => {
    const r = renderStarter(getStarter('quote_followup')!, { ...full, customer_name: '{{agency_name}} $& $1 <b>x</b>' });
    expect(r.text).toContain('agency_name $& $1 <b>x</b>');
    expect(r.text.match(/Golden Travels/g)).toHaveLength(1); // only the real {{agency_name}} slot
  });

  it('every occurrence of a repeated placeholder is filled', () => {
    const r = renderStarter({ key: 'x', label: 'x', description: '', body: '{{customer_name}} / {{ customer_name }}' }, full);
    expect(r.text).toBe('Rahul Shetty / Rahul Shetty');
  });
});

describe('cleanValue', () => {
  it('keeps a plain value', () => expect(cleanValue('  Coorg  ')).toBe('Coorg'));
  it('collapses whitespace and strips control characters and braces', () => expect(cleanValue('a\n\tb\u0000 {{c}}')).toBe('a b c'));
  it('caps the length', () => expect(cleanValue('x'.repeat(500))).toHaveLength(MAX_VALUE_LENGTH));
  it('returns empty for non-strings', () => { for (const v of [1, null, undefined, {}, []]) expect(cleanValue(v)).toBe(''); });
});
