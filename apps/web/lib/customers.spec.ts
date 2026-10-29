import { defaultPhonePrefix, displayPhone, normalizePhone, validateCustomerForm } from './customers';

describe('normalizePhone (must agree with the API)', () => {
  it('produces the canonical +digits form the webhook stores', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('+919876543210');
    expect(normalizePhone('00919876543210')).toBe('+919876543210');
    expect(normalizePhone('+1 (415) 555-2671')).toBe('+14155552671');
  });
  it('refuses numbers without a country code and other junk', () => {
    for (const bad of ['9876543210', '09876543210', '', '+', '+12', '+0919876543210', 'abc', '++919876543210', null, undefined]) expect(normalizePhone(bad as any)).toBeNull();
  });
});

describe('validateCustomerForm', () => {
  const ok = { name: 'Asha Rao', phone: '+91 98765 43210', email: '' };
  it('accepts a valid form, with or without an email', () => {
    expect(validateCustomerForm(ok)).toEqual({});
    expect(validateCustomerForm({ ...ok, email: 'asha@example.com' })).toEqual({});
  });
  it('reports each problem on its own field', () => {
    expect(Object.keys(validateCustomerForm({ name: 'A', phone: '12', email: 'nope' })).sort()).toEqual(['email', 'name', 'phone']);
    expect(validateCustomerForm({ ...ok, name: ' ' }).name).toMatch(/name/i);
    expect(validateCustomerForm({ ...ok, name: 'x'.repeat(121) }).name).toMatch(/too long/i);
  });
  it('does not require the phone when editing (it cannot be changed there)', () => {
    expect(validateCustomerForm({ name: 'Asha Rao', phone: '', email: '' }, false)).toEqual({});
  });
});

describe('helpers', () => {
  it('prefills +91 for Indian agencies and a bare + otherwise', () => {
    expect(defaultPhonePrefix('Asia/Kolkata')).toBe('+91 ');
    expect(defaultPhonePrefix(undefined)).toBe('+91 ');
    expect(defaultPhonePrefix('Europe/London')).toBe('+');
  });
  it('formats Indian numbers for reading and leaves others untouched', () => {
    expect(displayPhone('+919876543210')).toBe('+91 98765 43210');
    expect(displayPhone('+14155552671')).toBe('+14155552671');
    expect(displayPhone(null)).toBe('');
  });
});
