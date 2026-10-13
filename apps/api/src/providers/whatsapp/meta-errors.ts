/**
 * Maps Meta WhatsApp Cloud API errors to a small taxonomy the rest of the app can act on.
 * Codes are from Meta's published error-code reference as known to the authors and MUST be re-checked against
 * the current documentation (docs/WHATSAPP_INTEGRATION_DESIGN.md §11); unknown codes fall back safely.
 */
export type WaErrorKind =
  | 'auth'          // token invalid/expired/revoked or permission missing: reconnect needed
  | 'account'       // account-level problem: payment method, locked, number not registered
  | 'rate_limit'    // throttled: retry later
  | 'window_closed' // 24 h customer-service window is closed: template required
  | 'template'      // template missing, wrong variables or parameters
  | 'recipient'     // recipient cannot receive (not on WhatsApp, not allowed for a test number)
  | 'policy'        // blocked by Meta policy / engagement limits
  | 'transient'     // temporary Meta/server problem: retry
  | 'unknown';

export interface Classified { kind: WaErrorKind; retryable: boolean; hint: string }

const HINTS: Record<WaErrorKind, string> = {
  auth: 'The WhatsApp access token is invalid, expired or lacks permission. Reconnect the WhatsApp account in Settings.',
  account: 'There is a problem with the WhatsApp Business account (for example a missing payment method or an unregistered number). Check it in Meta Business Manager.',
  rate_limit: 'WhatsApp is rate-limiting this number. It will be retried automatically.',
  window_closed: 'The 24-hour customer service window is closed. Send an approved template to re-open the conversation.',
  template: 'The template is missing, not approved, or its variables do not match. Check the template and its variables.',
  recipient: 'WhatsApp could not deliver to this number. It may not be on WhatsApp, or (for a Meta test number) it is not in the allowed recipient list.',
  policy: 'Meta declined to deliver this message under its messaging policy or engagement limits.',
  transient: 'WhatsApp had a temporary problem. It will be retried automatically.',
  unknown: 'WhatsApp rejected the request.',
};

export const hintForKind = (kind: WaErrorKind) => HINTS[kind];

export function classifyMetaError(httpStatus: number, code?: number | string, message?: string): Classified {
  const c = Number(code);
  const done = (kind: WaErrorKind, retryable: boolean): Classified => ({ kind, retryable, hint: HINTS[kind] });
  if (httpStatus === 401 || c === 190 || c === 10 || (c >= 200 && c <= 299)) return done('auth', false);
  if ([131042, 131031, 133010, 131045, 131037].includes(c)) return done('account', false);
  if ([4, 17, 32, 613, 80007, 130429, 131056].includes(c) || httpStatus === 429) return done('rate_limit', true);
  if (c === 131047 || c === 131051 && /window|re-?engage/i.test(message ?? '')) return done('window_closed', false);
  if (c >= 132000 && c <= 132999) return done('template', false);
  if ([131026, 131030].includes(c)) return done('recipient', false);
  if ([368, 131048, 131049, 130472].includes(c)) return done('policy', false);
  if ([1, 2, 131000, 131016, 133004, 133005].includes(c) || httpStatus >= 500) return done('transient', true);
  return done('unknown', false);
}
