/**
 * Whether to OFFER the Delete action. This only decides what the screen shows; the API enforces the real rule
 * (tenant isolation, the agency's sales-visibility setting and ownership) and answers 403/404 regardless of what the UI does.
 *
 * Agency admins may delete any quote in their agency; sales users only quotes they own. Nobody else (e.g. the platform
 * super admin) gets the action.
 */
export function canDeleteQuote(user: { id: string; role: string }, ownerUserId: string | null | undefined): boolean {
  if (user.role === 'AGENCY_ADMIN') return true;
  if (user.role === 'SALES') return !!ownerUserId && ownerUserId === user.id;
  return false;
}

/** Reasons are optional; blank means "none". Kept to the API's 500-character limit. */
export const REASON_MAX = 500;
export const cleanReason = (s: string): string | undefined => { const t = s.trim().slice(0, REASON_MAX); return t || undefined; };
