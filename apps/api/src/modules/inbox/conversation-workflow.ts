/**
 * Conversation workflow, derived from events instead of picked by hand.
 *
 * The stored `Conversation.status` keeps its three existing values (no migration, existing rows stay valid):
 *   open    the customer is waiting for the agency (their latest message has not been answered)
 *   pending the agency has answered and is waiting for the customer
 *   closed  resolved
 * The four states shown to staff come from that value plus one fact: has the agency ever answered this chat?
 *   NEW       open, never answered
 *   ACTIVE    open, answered before (the customer came back, or the chat is being handled)
 *   WAITING   pending
 *   RESOLVED  closed
 *
 * Pure: no I/O. WhatsApp's 24-hour window and quote statuses are separate concepts and are not used here.
 */
export type Workflow = 'new' | 'active' | 'waiting' | 'resolved';

/** Stored status after each event. */
export const STATUS_AFTER_CUSTOMER_MESSAGE = 'open';
export const STATUS_AFTER_AGENCY_REPLY = 'pending';
export const STATUS_AFTER_RESOLVE = 'closed';

/**
 * An outbound message counts as the agency answering only once the provider has accepted it. A failed or still-queued message is not
 * an answer, so it never moves a chat to WAITING.
 */
export const ACCEPTED_REPLY_STATUSES = ['submitted', 'sent', 'delivered', 'read'] as const;

export function workflowOf(status: string, agencyHasReplied: boolean): Workflow {
  if (status === 'closed') return 'resolved';
  if (status === 'pending') return 'waiting';
  // 'open', and any unexpected legacy value, needs the agency's attention
  return agencyHasReplied ? 'active' : 'new';
}

/** Whether a send by this actor may move the chat to WAITING: only a person's own reply, never a background job. */
export const isEmployeeReply = (userId: string | null | undefined) => !!userId;
