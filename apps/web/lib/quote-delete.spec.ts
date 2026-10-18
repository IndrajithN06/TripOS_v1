import { canDeleteQuote, cleanReason, REASON_MAX } from './quote-delete';

describe('canDeleteQuote (what the UI offers; the API enforces the real rule)', () => {
  it('lets an agency admin delete any quote in the agency', () => {
    expect(canDeleteQuote({ id: 'a', role: 'AGENCY_ADMIN' }, 'someone-else')).toBe(true);
    expect(canDeleteQuote({ id: 'a', role: 'AGENCY_ADMIN' }, undefined)).toBe(true);
  });
  it('lets a sales user delete only their own quotes', () => {
    expect(canDeleteQuote({ id: 's1', role: 'SALES' }, 's1')).toBe(true);
    expect(canDeleteQuote({ id: 's1', role: 'SALES' }, 's2')).toBe(false);
    expect(canDeleteQuote({ id: 's1', role: 'SALES' }, null)).toBe(false);
    expect(canDeleteQuote({ id: 's1', role: 'SALES' }, undefined)).toBe(false);
  });
  it('never offers it to the platform super admin or an unknown role', () => {
    expect(canDeleteQuote({ id: 'x', role: 'SUPER_ADMIN' }, 'x')).toBe(false);
    expect(canDeleteQuote({ id: 'x', role: 'MYSTERY' }, 'x')).toBe(false);
  });
});

describe('cleanReason', () => {
  it('treats blank input as no reason and trims the rest', () => {
    expect(cleanReason('')).toBeUndefined();
    expect(cleanReason('   \n ')).toBeUndefined();
    expect(cleanReason('  Wrong dates  ')).toBe('Wrong dates');
  });
  it('never exceeds the API limit', () => {
    expect(cleanReason('x'.repeat(REASON_MAX + 50))).toHaveLength(REASON_MAX);
  });
});
