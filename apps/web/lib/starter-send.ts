/**
 * Pure rules for the inbox composer and the built-in message starters. The starter wording and the filled-in text come from the
 * API (one source); this file only decides what the composer may do with them.
 */
export interface SendBlock { code: 'whatsapp_not_connected' | 'window_closed'; message: string }

/** Matches an unfilled starter placeholder such as {{amount_due}}. Same shape the API uses. */
const UNFILLED = /\{\{\s*[a-z][a-z0-9_]*\s*\}\}/;

export const hasUnfilledPlaceholder = (text: string) => UNFILLED.test(text);

export function unfilledPlaceholders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(UNFILLED.source, 'g'))) {
    const name = m[0].replace(/[{}\s]/g, '');
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export interface ComposerState {
  /** The text box accepts typing. */
  canType: boolean;
  /** The server would accept a free-form text right now. */
  canSend: boolean;
  /** The ONE notice shown above the box, or null. A page-level disconnected banner already says the same thing, so it is not repeated. */
  notice: string | null;
  /** Longer explanation for the notice (tooltip). */
  noticeTitle: string | null;
  /** Placeholder for the text box; carries the short reason when typing is blocked. */
  placeholder: string;
  /** Steer the agent to the approved-template flow (only when the window, not the connection, is the problem). */
  suggestMetaTemplate: boolean;
}

export const WINDOW_CLOSED_NOTICE = 'Free-form replies are closed. Only an approved template can be sent.';
const DISCONNECTED_PLACEHOLDER = 'WhatsApp is disconnected: see the banner above';

export function composerState(o: { sendBlock: SendBlock | null | undefined; text: string; sending: boolean; disconnectedBannerVisible?: boolean }): ComposerState {
  if (o.sendBlock) {
    if (o.sendBlock.code === 'whatsapp_not_connected') {
      // The page-level banner already communicates this (and carries the link to Settings); repeat it only when no banner is showing.
      return o.disconnectedBannerVisible
        ? { canType: false, canSend: false, notice: null, noticeTitle: null, placeholder: DISCONNECTED_PLACEHOLDER, suggestMetaTemplate: false }
        : { canType: false, canSend: false, notice: o.sendBlock.message, noticeTitle: o.sendBlock.message, placeholder: 'Sending is not available right now', suggestMetaTemplate: false };
    }
    return { canType: false, canSend: false, notice: WINDOW_CLOSED_NOTICE, noticeTitle: o.sendBlock.message, placeholder: 'Free-form replies are closed', suggestMetaTemplate: true };
  }
  const missing = unfilledPlaceholders(o.text);
  if (missing.length) {
    const notice = `Fill in ${missing.map((m) => `{{${m}}}`).join(', ')} before sending.`;
    return { canType: true, canSend: false, notice, noticeTitle: null, placeholder: 'Type a message…', suggestMetaTemplate: false };
  }
  return { canType: true, canSend: !o.sending && !!o.text.trim(), notice: null, noticeTitle: null, placeholder: 'Type a message…', suggestMetaTemplate: false };
}

/** Only values the agent actually typed are sent back to the server; automatic values are re-derived there. */
export function enteredValues(edits: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(edits)) if (v.trim()) out[k] = v;
  return out;
}
