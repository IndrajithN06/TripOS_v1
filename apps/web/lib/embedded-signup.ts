/**
 * Pure helpers for Meta's Embedded Signup v4 popup (no DOM, no React), so the security-relevant parts are unit tested.
 * Event names and fields follow Meta's Embedded Signup v4 implementation guide (WA_EMBEDDED_SIGNUP message events).
 */

/** Only messages from facebook.com over https are trusted. Meta's sample checks `endsWith('facebook.com')`; this is stricter. */
export function isTrustedFacebookOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && (u.hostname === 'facebook.com' || u.hostname.endsWith('.facebook.com'));
  } catch { return false; }
}

export type SignupMessage =
  | { kind: 'finish'; type: string; wabaId?: string; phoneNumberId?: string; businessId?: string }
  | { kind: 'cancel'; step?: string; errorMessage?: string }
  | { kind: 'error'; errorMessage?: string };

/** Event types that mean "a WhatsApp number was connected" and that the server accepts. */
export const FINISH_TYPES = ['FINISH', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'];

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);

/** Parses a window `message` event. Returns null for anything that is not an Embedded Signup event from a trusted origin. */
export function parseSignupMessage(origin: string, raw: unknown): SignupMessage | null {
  if (!isTrustedFacebookOrigin(origin)) return null;
  let data: any = raw;
  if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch { return null; } }
  if (!data || typeof data !== 'object' || data.type !== 'WA_EMBEDDED_SIGNUP') return null;
  const event = String(data.event ?? '');
  const d = data.data ?? {};
  if (FINISH_TYPES.includes(event)) return { kind: 'finish', type: event, wabaId: str(d.waba_id), phoneNumberId: str(d.phone_number_id), businessId: str(d.business_id) };
  if (event === 'CANCEL') return { kind: 'cancel', step: str(d.current_step), errorMessage: str(d.error_message) };
  if (event === 'ERROR') return { kind: 'error', errorMessage: str(d.error_message) };
  return null; // FINISH_ONLY_WABA and other flows are not a usable connection here
}

/**
 * The popup reports its result in two separate places: the `message` event (account ids) and the FB.login callback (the one-time
 * code). They can arrive in either order; submit only once both are present, and only once.
 */
export function createSignupTracker(onReady: (r: { code: string; finish: Extract<SignupMessage, { kind: 'finish' }> }) => void, onAbort: (reason: string) => void) {
  let code: string | undefined, finish: Extract<SignupMessage, { kind: 'finish' }> | undefined, closed = false;
  const check = () => { if (!closed && code && finish) { closed = true; onReady({ code, finish }); } };
  return {
    setCode(c: string) { if (!closed) { code = c; check(); } },
    setMessage(m: SignupMessage) {
      if (closed) return;
      if (m.kind === 'finish') { finish = m; check(); return; }
      closed = true;
      onAbort(m.kind === 'cancel' ? (m.errorMessage ?? 'The Meta sign-up window was closed before it finished.') : (m.errorMessage ?? 'Meta reported an error during sign-up.'));
    },
    loginClosedWithoutCode() { if (!closed && !code) { closed = true; onAbort('The Meta sign-up window was closed before it finished.'); } },
    get settled() { return closed; },
    get hasCode() { return !!code; },
  };
}

/** Plain-language text for the server's error codes. */
export function explainSignupError(code: string | undefined, fallback: string): string {
  switch (code) {
    case 'whatsapp_already_connected': return 'This agency already has a WhatsApp connection, so nothing was changed. Disconnect it first if you want to replace it.';
    case 'whatsapp_in_use': return 'This WhatsApp number or business account is already connected to another agency.';
    case 'not_coexistence': return 'This number is not linked to the WhatsApp Business app, so it cannot be connected this way. Nothing was changed.';
    case 'asset_mismatch': return 'Meta reported a phone number that does not belong to that business account. Nothing was connected.';
    case 'phone_selection_required': return 'This business account has more than one number. Choosing a number is not supported yet.';
    case 'code_required': case 'code_already_used': return 'Meta needs to confirm again. Click Connect to run the Meta window once more.';
    case 'signup_expired': return 'This sign-up took too long and expired. Start again.';
    case 'feature_disabled': return 'Embedded Signup is not enabled for this installation.';
    default: return fallback;
  }
}
