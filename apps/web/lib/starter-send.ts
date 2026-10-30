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
  /** Plain-language reason shown above the box when typing is blocked, or when a starter placeholder is still unfilled. */
  notice: string | null;
  /** Steer the agent to the approved-template flow (only when the window, not the connection, is the problem). */
  suggestMetaTemplate: boolean;
}

export function composerState(o: { sendBlock: SendBlock | null | undefined; text: string; sending: boolean }): ComposerState {
  if (o.sendBlock) {
    return { canType: false, canSend: false, notice: o.sendBlock.message, suggestMetaTemplate: o.sendBlock.code === 'window_closed' };
  }
  const missing = unfilledPlaceholders(o.text);
  if (missing.length) {
    return { canType: true, canSend: false, notice: `Fill in ${missing.map((m) => `{{${m}}}`).join(', ')} before sending.`, suggestMetaTemplate: false };
  }
  return { canType: true, canSend: !o.sending && !!o.text.trim(), notice: null, suggestMetaTemplate: false };
}

/** Only values the agent actually typed are sent back to the server; automatic values are re-derived there. */
export function enteredValues(edits: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(edits)) if (v.trim()) out[k] = v;
  return out;
}
