/**
 * Pure helpers for the inbox workflow chip, the next-step hint and the customer summary. No DOM, no clock, no guessing:
 * every rule below works from what the API already reports (the conversation's workflow, its quotes and their flags).
 */
export type Workflow = 'new' | 'active' | 'waiting' | 'resolved';

export interface WorkflowChip { label: string; tone: 'blue' | 'green' | 'amber' | 'gray'; title: string }

/** What staff see for each state (the API derives the state from messages; nobody picks it by hand). */
export function workflowChip(w: string | null | undefined): WorkflowChip {
  switch (w) {
    case 'new': return { label: 'New', tone: 'blue', title: 'New enquiry: the customer is waiting for a first reply' };
    case 'waiting': return { label: 'Waiting', tone: 'amber', title: 'You replied: waiting for the customer' };
    case 'resolved': return { label: 'Resolved', tone: 'gray', title: 'Resolved. A new message from the customer reopens it' };
    case 'active':
    default: return { label: 'Active', tone: 'green', title: 'Being handled: the customer is waiting for the next reply' };
  }
}

export interface QuoteLike { quoteNumber: string; status: string; followUpOverdue?: boolean }
export interface NextStep { text: string; tone: 'urgent' | 'action' | 'good' | 'quiet' }

const AWAITING = ['sent', 'negotiating'];
const UNSENT = ['draft', 'ready_to_send', 'send_failed', 'partially_sent'];

/**
 * One short, deterministic suggestion. Order matters: resolved first, then the most valuable or most urgent quotation signal.
 * It reads only existing statuses and flags; it creates nothing and never claims the customer has read or accepted anything.
 */
export function nextStep(o: { workflow: string; quotes: QuoteLike[] }): NextStep {
  if (o.workflow === 'resolved') return { text: 'No immediate action.', tone: 'quiet' };
  const accepted = o.quotes.find((q) => q.status === 'accepted');
  if (accepted) return { text: `Quotation ${accepted.quoteNumber} accepted: continue the booking process.`, tone: 'good' };
  const overdue = o.quotes.find((q) => AWAITING.includes(q.status) && q.followUpOverdue);
  if (overdue) return { text: `Follow up on overdue quotation ${overdue.quoteNumber}.`, tone: 'urgent' };
  const awaiting = o.quotes.find((q) => AWAITING.includes(q.status));
  if (awaiting) return { text: `Quotation ${awaiting.quoteNumber} is awaiting the customer's response: follow up.`, tone: 'action' };
  const failed = o.quotes.find((q) => q.status === 'send_failed' || q.status === 'partially_sent');
  if (failed) return { text: `Quotation ${failed.quoteNumber} was not fully delivered: retry sending it.`, tone: 'urgent' };
  const unsent = o.quotes.find((q) => UNSENT.includes(q.status));
  if (unsent) return { text: `Finish and send quotation ${unsent.quoteNumber}.`, tone: 'action' };
  if (o.quotes.length > 0) {
    // only declined or expired quotations remain
    const last = o.quotes[0];
    return { text: last.status === 'declined' ? `Quotation ${last.quoteNumber} was declined: ask what would work, or resolve the enquiry.` : `Quotation ${last.quoteNumber} expired: send a revised quotation or follow up.`, tone: 'action' };
  }
  return o.workflow === 'new' ? { text: 'Review the customer enquiry.', tone: 'action' } : { text: 'Create a quotation.', tone: 'action' };
}

export interface History { otherConversations: number; quotes: number; acceptedQuotes: number }

/** Only the facts that exist; never a row of zeros. Returns an empty list when there is nothing worth saying. */
export function historyParts(h: History | null | undefined): string[] {
  if (!h) return [];
  const out: string[] = [];
  if (h.quotes > 0) out.push(`${h.quotes} ${h.quotes === 1 ? 'quotation' : 'quotations'}`);
  if (h.acceptedQuotes > 0) out.push(`${h.acceptedQuotes} accepted`);
  if (h.otherConversations > 0) out.push(`${h.otherConversations} earlier ${h.otherConversations === 1 ? 'conversation' : 'conversations'}`);
  return out;
}

export interface WindowView { kind: 'open' | 'closed' | 'never'; at: string | null }

/** The 24-hour window exactly as the API reports it. The expiry time comes from the server; nothing is calculated here. */
export function windowView(o: { windowOpen: boolean; windowExpiresAt?: string | null }): WindowView {
  if (o.windowOpen) return { kind: 'open', at: o.windowExpiresAt ?? null };
  return o.windowExpiresAt ? { kind: 'closed', at: o.windowExpiresAt } : { kind: 'never', at: null };
}

/** Short name for what a quotation is for: its destination, or the kind of package when there is no destination. */
export function quoteWhat(q: { destination?: string | null; tripType?: string | null }): string {
  if (q.destination) return q.destination;
  if (q.tripType && q.tripType.startsWith('local')) return 'Local package';
  return 'Quotation';
}
