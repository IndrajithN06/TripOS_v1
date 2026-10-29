/**
 * Canonical phone number format: E.164 with a leading "+" and digits only (e.g. +919876543210).
 *
 * This is exactly the format the WhatsApp webhook parser stores (it prefixes the digits Meta sends with "+"), and
 * `Customer` is unique on (agencyId, phoneE164). A customer typed in by staff and the same person messaging later therefore
 * resolve to ONE row, as long as every writer uses this one format.
 *
 * Deliberately strict: no country code is guessed. Input must start with "+" (or the international prefix "00"), so a bare
 * national number is refused instead of being silently attached to the wrong country.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/[\s().\-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!/^\+\d{8,15}$/.test(s)) return null; // E.164 allows at most 15 digits
  if (s[1] === '0') return null; // a country calling code never starts with 0
  return s;
}
