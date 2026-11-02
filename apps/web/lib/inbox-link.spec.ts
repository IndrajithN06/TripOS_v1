import { conversationFromSearch, inboxLink, isConversationId, latestConversationId, listPath } from './inbox-link';

const A = '0f6c3b1e-3c1d-4d0a-9d0e-2b1a8e7f6a51';
const B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('inboxLink', () => {
  it('names the exact conversation', () => expect(inboxLink(A)).toBe(`/inbox?conversation=${A}`));
  it('falls back to the plain inbox when there is no usable id', () => {
    for (const v of [null, undefined, '', 'not-an-id', '../etc/passwd', `${A}&x=1`, `${A}<script>`]) expect(inboxLink(v as never)).toBe('/inbox');
  });
});

describe('conversationFromSearch', () => {
  it('reads a valid id from the query string', () => {
    expect(conversationFromSearch(`?conversation=${A}`)).toBe(A);
    expect(conversationFromSearch(`?x=1&conversation=${B}&y=2`)).toBe(B);
  });
  it('ignores a missing, empty or malformed value', () => {
    for (const s of ['', '?', '?conversation=', '?conversation=abc', `?conversation=${A}x`, '?other=1', null, undefined]) expect(conversationFromSearch(s as never)).toBeNull();
  });
  it('round-trips with inboxLink', () => expect(conversationFromSearch(inboxLink(A).split('?')[1] ? `?${inboxLink(A).split('?')[1]}` : '')).toBe(A));
});

describe('latestConversationId', () => {
  it('picks the most recently active conversation', () => {
    expect(latestConversationId([{ id: A, lastMessageAt: '2026-10-01T10:00:00Z' }, { id: B, lastMessageAt: '2026-10-05T10:00:00Z' }])).toBe(B);
    expect(latestConversationId([{ id: B, lastMessageAt: '2026-10-05T10:00:00Z' }, { id: A, lastMessageAt: '2026-10-01T10:00:00Z' }])).toBe(B);
  });
  it('works with one conversation, and with a missing timestamp', () => {
    expect(latestConversationId([{ id: A }])).toBe(A);
    expect(latestConversationId([{ id: A }, { id: B, lastMessageAt: '2026-10-05T10:00:00Z' }])).toBe(B);
  });
  it('returns null when the customer has no conversation', () => {
    expect(latestConversationId([])).toBeNull();
    expect(latestConversationId(null)).toBeNull();
    expect(latestConversationId(undefined)).toBeNull();
  });
});

describe('isConversationId', () => {
  it('accepts a UUID only', () => {
    expect(isConversationId(A)).toBe(true);
    expect(isConversationId(A.toUpperCase())).toBe(true);
    expect(isConversationId('123')).toBe(false);
    expect(isConversationId(42 as never)).toBe(false);
  });
});

describe('listPath: the opened chat is pinned only to the plain list', () => {
  it('adds focus for the unfiltered, unsearched list', () => {
    expect(listPath({ filter: 'all', search: '', focusId: A })).toBe(`/inbox/conversations?filter=all&search=&focus=${A}`);
  });
  it('leaves it out when a filter or a search is active, so the list shows exactly what matches', () => {
    expect(listPath({ filter: 'unread', search: '', focusId: A })).toBe('/inbox/conversations?filter=unread&search=');
    expect(listPath({ filter: 'all', search: 'priya', focusId: A })).toBe('/inbox/conversations?filter=all&search=priya');
  });
  it('leaves it out without a usable id, and encodes the search text', () => {
    for (const f of [null, undefined, '', 'nope']) expect(listPath({ filter: 'all', search: '', focusId: f as never })).toBe('/inbox/conversations?filter=all&search=');
    expect(listPath({ filter: 'unread', search: 'a b&c', focusId: null })).toContain('search=a%20b%26c');
  });
});
