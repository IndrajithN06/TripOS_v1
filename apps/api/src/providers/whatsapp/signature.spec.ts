import { createHmac } from 'crypto';
import { metaSignatureHeader, verifyMetaSignature } from './signature';

// Real HMAC-SHA256, no mocks: the header format and the keying are exactly what Meta documents
// (X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(raw body, app secret)). Secrets here are throwaway test strings.
const SECRET = 'unit-test-app-secret-A';
const OTHER = 'unit-test-app-secret-B';
const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W1', changes: [] }] }));
const hex = (b: Buffer, s: string) => createHmac('sha256', s).update(b).digest('hex');

describe('verifyMetaSignature', () => {
  it('accepts a correct signature', () => {
    expect(verifyMetaSignature(body, `sha256=${hex(body, SECRET)}`, SECRET)).toBe(true);
    expect(verifyMetaSignature(body, metaSignatureHeader(body, SECRET), SECRET)).toBe(true);
  });
  it('accepts upper-case hex and surrounding whitespace in the header (same digest)', () => {
    expect(verifyMetaSignature(body, `sha256=${hex(body, SECRET).toUpperCase()}`, SECRET)).toBe(true);
    expect(verifyMetaSignature(body, ` sha256=${hex(body, SECRET)} `, SECRET)).toBe(true);
  });
  it('rejects a signature made with a different secret', () => {
    expect(verifyMetaSignature(body, metaSignatureHeader(body, OTHER), SECRET)).toBe(false);
  });
  it('rejects a tampered body, even by one byte', () => {
    const header = metaSignatureHeader(body, SECRET);
    expect(verifyMetaSignature(Buffer.from(body.toString() + ' '), header, SECRET)).toBe(false);
    const flipped = Buffer.from(body); flipped[10] ^= 1;
    expect(verifyMetaSignature(flipped, header, SECRET)).toBe(false);
    expect(verifyMetaSignature(Buffer.from(''), header, SECRET)).toBe(false);
  });
  it('rejects a missing header or an empty/missing secret', () => {
    expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(body, '', SECRET)).toBe(false);
    expect(verifyMetaSignature(body, metaSignatureHeader(body, SECRET), undefined)).toBe(false);
    expect(verifyMetaSignature(body, metaSignatureHeader(body, SECRET), '')).toBe(false);
    // An empty secret must not "verify" an HMAC computed with an empty key.
    expect(verifyMetaSignature(body, metaSignatureHeader(body, ''), '')).toBe(false);
  });
  it.each([
    ['no prefix', hex(body, SECRET)],
    ['wrong scheme', `sha1=${hex(body, SECRET).slice(0, 40)}`],
    ['sha256 with no digest', 'sha256='],
    ['too short', `sha256=${hex(body, SECRET).slice(0, 32)}`],
    ['too long', `sha256=${hex(body, SECRET)}00`],
    ['non-hex characters', `sha256=${'z'.repeat(64)}`],
    ['prefix only in the middle', `x sha256=${hex(body, SECRET)}`],
    ['two signatures', `sha256=${hex(body, SECRET)},sha256=${hex(body, SECRET)}`],
  ])('rejects a malformed header: %s', (_name, header) => {
    expect(verifyMetaSignature(body, header, SECRET)).toBe(false);
  });
});
