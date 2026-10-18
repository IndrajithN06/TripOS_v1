import { StatusBadge } from '@/components/ui';
import { tickFor } from '@/lib/inbox-view';

/** WhatsApp-style delivery indicator for an outbound message. Colour is never the only signal: every state has its own shape and a text label. */
export function MessageTicks({ status }: { status: string }) {
  const t = tickFor(status);
  if (t.kind === 'none') return <StatusBadge s={status} />; // unknown state: show the raw status rather than guess
  return (
    <span className={`ticks ${t.kind}`} role="img" aria-label={t.label} title={t.label}>
      <svg viewBox="0 0 16 11" width="16" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {t.kind === 'pending' && <><circle cx="8" cy="5.5" r="4.2" /><path d="M8 3.2v2.5l1.7 1" /></>}
        {t.kind === 'sent' && <path d="M5 5.8 7.4 8.2 12.2 2.6" />}
        {(t.kind === 'delivered' || t.kind === 'read') && <><path d="M1.6 5.8 4 8.2 8.8 2.6" /><path d="M6.4 8.2 7.2 8.2 12.4 2.6" /></>}
        {t.kind === 'failed' && <><circle cx="8" cy="5.5" r="4.4" /><path d="M8 3.2v2.9M8 7.9v.1" /></>}
      </svg>
    </span>
  );
}
