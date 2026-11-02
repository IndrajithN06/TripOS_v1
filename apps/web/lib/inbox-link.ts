/**
 * Deep links into the WhatsApp inbox. A link names the exact conversation (`/inbox?conversation=<id>`), so "Open chat" from a customer or a
 * quotation lands on that customer's chat instead of whichever chat happens to be first in the list. The server still decides who may see a
 * conversation: an id the person is not allowed to open simply shows "Conversation not found".
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isConversationId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** The inbox link for one conversation, or the plain inbox when there is no (valid) id. */
export function inboxLink(conversationId: string | null | undefined): string {
  return isConversationId(conversationId) ? `/inbox?conversation=${conversationId}` : '/inbox';
}

/** Reads the conversation id from a URL query string (`location.search`). Anything that is not a well-formed id is ignored. */
export function conversationFromSearch(search: string | null | undefined): string | null {
  if (!search) return null;
  const id = new URLSearchParams(search).get('conversation');
  return isConversationId(id) ? id : null;
}

/** The customer's most recently active conversation (a customer normally has one). Null when there is none. */
export function latestConversationId(list: { id: string; lastMessageAt?: string | null }[] | null | undefined): string | null {
  if (!list?.length) return null;
  const time = (c: { lastMessageAt?: string | null }) => (c.lastMessageAt ? new Date(c.lastMessageAt).getTime() : 0);
  return [...list].sort((a, b) => time(b) - time(a))[0].id;
}

/**
 * The conversation-list request. The opened chat (`focusId`) is pinned to the top of the unfiltered list only: with a filter or a search the list
 * must show exactly what matches, so the pin is left out then.
 */
export function listPath(o: { filter: string; search: string; focusId?: string | null }): string {
  const base = `/inbox/conversations?filter=${o.filter}&search=${encodeURIComponent(o.search)}`;
  return isConversationId(o.focusId) && o.filter === 'all' && !o.search ? `${base}&focus=${o.focusId}` : base;
}
