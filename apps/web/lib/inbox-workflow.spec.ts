import { historyParts, nextStep, quoteWhat, windowView, workflowChip } from './inbox-workflow';

const q = (quoteNumber: string, status: string, followUpOverdue = false) => ({ quoteNumber, status, followUpOverdue });

describe('workflowChip', () => {
  it('has one distinct label and colour per state', () => {
    expect(workflowChip('new')).toMatchObject({ label: 'New', tone: 'blue' });
    expect(workflowChip('active')).toMatchObject({ label: 'Active', tone: 'green' });
    expect(workflowChip('waiting')).toMatchObject({ label: 'Waiting', tone: 'amber' });
    expect(workflowChip('resolved')).toMatchObject({ label: 'Resolved', tone: 'gray' });
  });
  it('an unknown or missing value falls back to Active rather than hiding the chat', () => {
    expect(workflowChip(undefined).label).toBe('Active');
    expect(workflowChip('???').label).toBe('Active');
  });
  it('every state explains itself', () => {
    for (const w of ['new', 'active', 'waiting', 'resolved']) expect(workflowChip(w).title.length).toBeGreaterThan(15);
  });
});

describe('nextStep: deterministic guidance from existing data', () => {
  it('resolved conversation -> no immediate action, whatever the quotes say', () => {
    expect(nextStep({ workflow: 'resolved', quotes: [q('Q-1', 'sent', true)] })).toEqual({ text: 'No immediate action.', tone: 'quiet' });
  });
  it('new enquiry with no quotation -> review the enquiry', () => expect(nextStep({ workflow: 'new', quotes: [] }).text).toBe('Review the customer enquiry.'));
  it('being handled with no quotation -> create a quotation', () => {
    expect(nextStep({ workflow: 'active', quotes: [] }).text).toBe('Create a quotation.');
    expect(nextStep({ workflow: 'waiting', quotes: [] }).text).toBe('Create a quotation.');
  });
  it('quotation awaiting the customer -> follow up', () => {
    expect(nextStep({ workflow: 'waiting', quotes: [q('Q-2', 'sent')] })).toMatchObject({ text: expect.stringContaining('follow up'), tone: 'action' });
    expect(nextStep({ workflow: 'active', quotes: [q('Q-2', 'negotiating')] }).text).toContain('Q-2');
  });
  it('overdue quotation -> urgent follow-up, and it outranks a plain awaiting one', () => {
    const s = nextStep({ workflow: 'waiting', quotes: [q('Q-3', 'sent'), q('Q-4', 'sent', true)] });
    expect(s).toEqual({ text: 'Follow up on overdue quotation Q-4.', tone: 'urgent' });
  });
  it('an overdue flag on a quotation that is not open does not count', () => {
    expect(nextStep({ workflow: 'active', quotes: [q('Q-5', 'draft', true)] }).text).toBe('Finish and send quotation Q-5.');
  });
  it('accepted quotation -> continue the booking process, ahead of everything else', () => {
    expect(nextStep({ workflow: 'active', quotes: [q('Q-6', 'sent', true), q('Q-7', 'accepted')] })).toEqual({ text: 'Quotation Q-7 accepted: continue the booking process.', tone: 'good' });
  });
  it('a draft is finished and sent; a failed or partial send is retried', () => {
    expect(nextStep({ workflow: 'active', quotes: [q('Q-8', 'draft')] }).text).toBe('Finish and send quotation Q-8.');
    expect(nextStep({ workflow: 'active', quotes: [q('Q-9', 'send_failed')] })).toMatchObject({ text: expect.stringContaining('retry sending'), tone: 'urgent' });
    expect(nextStep({ workflow: 'active', quotes: [q('Q-9', 'partially_sent')] }).text).toContain('retry sending');
  });
  it('only declined or expired quotations -> a sensible next move, not a blank', () => {
    expect(nextStep({ workflow: 'active', quotes: [q('Q-10', 'declined')] }).text).toContain('declined');
    expect(nextStep({ workflow: 'active', quotes: [q('Q-11', 'expired')] }).text).toContain('expired');
  });
  it('never claims the customer read or accepted anything it was not told', () => {
    for (const status of ['sent', 'negotiating', 'draft', 'declined', 'expired']) expect(nextStep({ workflow: 'active', quotes: [q('Q-12', status)] }).text).not.toMatch(/\bread\b|viewed/i);
  });
});

describe('historyParts: only facts that exist', () => {
  it('lists quotations, accepted and earlier conversations', () => {
    expect(historyParts({ otherConversations: 2, quotes: 3, acceptedQuotes: 1 })).toEqual(['3 quotations', '1 accepted', '2 earlier conversations']);
  });
  it('uses the singular', () => expect(historyParts({ otherConversations: 1, quotes: 1, acceptedQuotes: 0 })).toEqual(['1 quotation', '1 earlier conversation']));
  it('never shows zeros: a brand-new customer has nothing to say', () => {
    expect(historyParts({ otherConversations: 0, quotes: 0, acceptedQuotes: 0 })).toEqual([]);
    expect(historyParts(null)).toEqual([]);
    expect(historyParts(undefined)).toEqual([]);
  });
});

describe('windowView: reports the server\'s window, never calculates one', () => {
  it('open -> the server expiry time', () => expect(windowView({ windowOpen: true, windowExpiresAt: '2030-01-02T10:00:00.000Z' })).toEqual({ kind: 'open', at: '2030-01-02T10:00:00.000Z' }));
  it('closed -> when it closed, as reported', () => expect(windowView({ windowOpen: false, windowExpiresAt: '2030-01-01T10:00:00.000Z' })).toEqual({ kind: 'closed', at: '2030-01-01T10:00:00.000Z' }));
  it('the customer never wrote -> no window and no invented time', () => expect(windowView({ windowOpen: false, windowExpiresAt: null })).toEqual({ kind: 'never', at: null }));
});

describe('quoteWhat', () => {
  it('prefers the destination', () => expect(quoteWhat({ destination: 'Coorg', tripType: 'outstation' })).toBe('Coorg'));
  it('names a local package when there is no destination', () => expect(quoteWhat({ destination: null, tripType: 'local_8h_80km' })).toBe('Local package'));
  it('falls back to a plain word, never blank', () => expect(quoteWhat({})).toBe('Quotation'));
});
