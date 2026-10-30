/**
 * The WhatsApp customer-service window, in one place. Meta allows a free-form message only within 24 hours of the customer's
 * most recent inbound message; outside it only an approved template may be sent. Pure: no clock, no I/O (callers pass `now`).
 */
export const SERVICE_WINDOW_MS = 24 * 3600 * 1000;

export interface WindowState { open: boolean; expiresAt: Date | null }

/** Open while strictly less than 24 hours have passed since the last inbound message. Exactly 24 hours is closed. */
export function windowState(lastInboundAt: Date | null | undefined, now: number = Date.now()): WindowState {
  if (!lastInboundAt) return { open: false, expiresAt: null };
  return { open: now - lastInboundAt.getTime() < SERVICE_WINDOW_MS, expiresAt: new Date(lastInboundAt.getTime() + SERVICE_WINDOW_MS) };
}

export type SendBlockCode = 'whatsapp_not_connected' | 'window_closed';
export interface SendBlock { code: SendBlockCode; message: string }
export interface AccountLike { connectionStatus: string; statusReason?: string | null }

export function notConnectedMessage(account: AccountLike | null | undefined): string {
  if (!account) return 'No WhatsApp number is connected. An agency admin can connect one in Settings, then messages can be sent.';
  const why = account.statusReason?.trim();
  return `WhatsApp is disconnected${why ? `: ${why}` : ''}. An agency admin needs to reconnect it in Settings before any message can be sent.`;
}

export function windowClosedMessage(s: WindowState): string {
  return s.expiresAt
    ? 'The 24-hour customer service window has closed, so WhatsApp only allows an approved template now. A free-form message becomes possible again as soon as the customer replies.'
    : 'This customer has not messaged you yet, so WhatsApp only allows an approved template to start the conversation. A free-form message becomes possible once they reply.';
}

/** Why a free-form text cannot be sent right now, or null if it can. A disconnected account is reported before a closed window. */
export function textSendBlock(conv: { lastInboundAt: Date | null }, account: AccountLike | null | undefined, now: number = Date.now()): SendBlock | null {
  if (!account || account.connectionStatus === 'disconnected') return { code: 'whatsapp_not_connected', message: notConnectedMessage(account) };
  const w = windowState(conv.lastInboundAt, now);
  return w.open ? null : { code: 'window_closed', message: windowClosedMessage(w) };
}
