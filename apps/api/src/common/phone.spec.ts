import { normalizePhone } from './phone';

describe('normalizePhone (canonical +<digits>, the format the webhook stores)', () => {
  it('keeps a clean E.164 number unchanged', () => {
    expect(normalizePhone('+919876543210')).toBe('+919876543210');
  });
  it('strips spaces, dashes, dots and brackets', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('+919876543210');
    expect(normalizePhone(' +91-98765-43210 ')).toBe('+919876543210');
    expect(normalizePhone('+1 (415) 555.2671')).toBe('+14155552671');
  });
  it('turns the international prefix 00 into +', () => {
    expect(normalizePhone('00919876543210')).toBe('+919876543210');
  });
  it('matches what the webhook parser produces for the same person ("+" + the digits Meta sends)', () => {
    const fromMeta = `+${'919876543210'}`;
    expect(normalizePhone('+91 98765 43210')).toBe(fromMeta);
  });
  it('refuses a national number without a country code instead of guessing one', () => {
    expect(normalizePhone('9876543210')).toBeNull();
    expect(normalizePhone('09876543210')).toBeNull();
  });
  it('refuses junk, too short, too long, a leading zero after + and non-strings', () => {
    for (const bad of ['', '   ', '+', '+12', '+1234567', '+1234567890123456', '+0919876543210', '+91abc9876543', 'not a phone', '++919876543210', '+91 98765 43210 ext 5']) expect(normalizePhone(bad)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(12345678901 as unknown as string)).toBeNull();
  });
  it('accepts the 8 and 15 digit limits', () => {
    expect(normalizePhone('+12345678')).toBe('+12345678');
    expect(normalizePhone('+123456789012345')).toBe('+123456789012345');
  });
});
