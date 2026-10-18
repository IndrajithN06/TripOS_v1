import { DEFAULT_TZ } from './format';

/** What to draw next to an OUTBOUND message's time. Derived only from the status the backend reports. */
export type TickKind = 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'none';
export interface Tick { kind: TickKind; label: string }

/**
 * Message status -> tick. Mirrors the backend's lifecycle (queued | submitted | sent | delivered | read | failed).
 * "read" (blue ticks) is shown ONLY for the exact status `read`; nothing is inferred from other fields.
 * "submitted" means the provider accepted the request but has not confirmed it, so it is NOT shown as sent.
 * Any status we do not know yields `none` so the caller can fall back to a plain text badge instead of guessing.
 */
export function tickFor(status: string | null | undefined): Tick {
  switch (status) {
    case 'queued': return { kind: 'pending', label: 'Queued' };
    case 'submitted': return { kind: 'pending', label: 'Submitted to WhatsApp, awaiting confirmation' };
    case 'sent': return { kind: 'sent', label: 'Sent' };
    case 'delivered': return { kind: 'delivered', label: 'Delivered' };
    case 'read': return { kind: 'read', label: 'Read' };
    case 'failed': return { kind: 'failed', label: 'Failed' };
    default: return { kind: 'none', label: status ?? '' };
  }
}

/** Up to two initials for an avatar; falls back to "?" for an empty or symbol-only name. */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const first = (s: string) => (s.match(/[\p{L}\p{N}]/u) ?? [''])[0];
  const out = (first(parts[0] ?? '') + (parts.length > 1 ? first(parts[parts.length - 1]) : '')).toUpperCase();
  return out || '?';
}

const dayKey = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** "Today" / "Yesterday" / "12 Oct 2026", judged in the agency's timezone. */
export function dayLabel(d: string | Date, tz = DEFAULT_TZ, now: Date = new Date()): string {
  const date = new Date(d);
  const key = dayKey(date, tz);
  if (key === dayKey(now, tz)) return 'Today';
  if (key === dayKey(new Date(now.getTime() - 86_400_000), tz)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}
