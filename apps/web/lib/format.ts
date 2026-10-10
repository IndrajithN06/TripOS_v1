export const DEFAULT_TZ = 'Asia/Kolkata';

export function inr(v: string | number | null | undefined) {
  if (v === null || v === undefined || v === '') return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(Number(v));
}

/** Timestamps are stored in UTC and displayed in the agency timezone (IST by default). */
export function fmtDateTime(d: string | Date | null | undefined, tz = DEFAULT_TZ) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(d));
}
export function fmtTime(d: string | Date, tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(d));
}
export function fmtRelative(d: string | Date) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Converts a <input type="datetime-local"> value (wall clock in `tz`) to a UTC ISO string. */
export function zonedToIso(local: string, tz = DEFAULT_TZ) {
  if (!local) return null;
  const asUtc = new Date(local + ':00Z').getTime();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(asUtc));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const wall = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return new Date(asUtc - (wall - asUtc)).toISOString();
}
/** Inverse: UTC ISO -> datetime-local string in `tz`. */
export function isoToZoned(iso: string | null | undefined, tz = DEFAULT_TZ) {
  if (!iso) return '';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', ready_to_send: 'Ready to send', sent: 'Sent', negotiating: 'Negotiating', accepted: 'Accepted', declined: 'Declined', expired: 'Expired', send_failed: 'Send failed',
  partially_sent: 'Partially sent', failed: 'Failed', sending: 'Sending',
};
