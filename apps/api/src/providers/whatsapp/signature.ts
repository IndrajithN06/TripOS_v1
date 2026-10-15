import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Meta signs every webhook POST with `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the RAW body keyed with the app secret
 * of the app that owns the subscription. Pure and strict on purpose: it knows exactly one secret, so a caller can never end up
 * "accepting whichever app's secret matches". A missing secret, a missing/malformed header or any mismatch is a plain `false`.
 */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(m[1], 'hex'), expected);
}

/** Test helper / documentation of the exact header Meta sends. */
export function metaSignatureHeader(rawBody: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
