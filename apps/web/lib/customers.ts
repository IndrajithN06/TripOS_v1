/**
 * Pure helpers for the Customers screens. The phone rule MUST match the API (apps/api/src/common/phone.ts): canonical form is
 * "+" followed by 8 to 15 digits, which is also the format WhatsApp webhooks store, so a hand-typed customer and the same person
 * messaging later are one record. The server is the real authority; this only gives instant feedback.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/[\s().\-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!/^\+\d{8,15}$/.test(s)) return null;
  if (s[1] === '0') return null;
  return s;
}

/** What the phone box starts with: Indian agencies get "+91 " (a convenience the user can edit), everyone else just "+". */
export const defaultPhonePrefix = (timezone?: string | null) => (!timezone || timezone === 'Asia/Kolkata' ? '+91 ' : '+');

export interface CustomerForm { name: string; phone: string; email: string }
export type CustomerFormErrors = Partial<Record<keyof CustomerForm, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Field-level messages for the create/edit form. `requirePhone` is false when editing (the phone cannot be changed). */
export function validateCustomerForm(f: CustomerForm, requirePhone = true): CustomerFormErrors {
  const e: CustomerFormErrors = {};
  if (f.name.trim().length < 2) e.name = 'Enter the customer\'s name (at least 2 characters).';
  if (f.name.trim().length > 120) e.name = 'The name is too long (120 characters at most).';
  if (requirePhone && !normalizePhone(f.phone)) e.phone = 'Enter the phone number with its country code, for example +91 98765 43210.';
  if (f.email.trim() && !EMAIL.test(f.email.trim())) e.email = 'Enter a valid email address, or leave it empty.';
  return e;
}

/** "+919876543210" -> "+91 98765 43210" for Indian numbers; anything else is shown as stored. */
export function displayPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}
