import { ACCEPTED_REPLY_STATUSES, isEmployeeReply, STATUS_AFTER_AGENCY_REPLY, STATUS_AFTER_CUSTOMER_MESSAGE, STATUS_AFTER_RESOLVE, workflowOf } from './conversation-workflow';

describe('workflowOf: the four states shown to staff', () => {
  it('open and never answered -> NEW', () => expect(workflowOf('open', false)).toBe('new'));
  it('open and answered before (the customer came back, or it is being handled) -> ACTIVE', () => expect(workflowOf('open', true)).toBe('active'));
  it('pending (the agency answered and waits for the customer) -> WAITING, whether or not a reply is on record', () => {
    expect(workflowOf('pending', true)).toBe('waiting');
    expect(workflowOf('pending', false)).toBe('waiting'); // older rows may hold pending without a reply on record
  });
  it('closed -> RESOLVED', () => {
    expect(workflowOf('closed', true)).toBe('resolved');
    expect(workflowOf('closed', false)).toBe('resolved');
  });
  it('an unexpected legacy value is treated as needing attention, never hidden', () => {
    expect(workflowOf('something_else', false)).toBe('new');
    expect(workflowOf('', true)).toBe('active');
  });
});

describe('stored status after each event (uses only the three existing values)', () => {
  it('maps events to open / pending / closed', () => {
    expect(STATUS_AFTER_CUSTOMER_MESSAGE).toBe('open');
    expect(STATUS_AFTER_AGENCY_REPLY).toBe('pending');
    expect(STATUS_AFTER_RESOLVE).toBe('closed');
  });

  it('a customer message returns a waiting or resolved chat to the agency: ACTIVE if it was answered before, NEW if never', () => {
    // waiting chat, customer replies -> open + answered before -> ACTIVE
    expect(workflowOf(STATUS_AFTER_CUSTOMER_MESSAGE, true)).toBe('active');
    // resolved chat that was never answered (for example resolved by mistake), customer writes again -> NEW
    expect(workflowOf(STATUS_AFTER_CUSTOMER_MESSAGE, false)).toBe('new');
  });

  it('after an employee reply the chat is WAITING', () => expect(workflowOf(STATUS_AFTER_AGENCY_REPLY, true)).toBe('waiting'));
  it('after Resolve the chat is RESOLVED', () => expect(workflowOf(STATUS_AFTER_RESOLVE, true)).toBe('resolved'));
});

describe('what counts as the agency answering', () => {
  it('only messages the provider has accepted; never failed or still-queued ones', () => {
    expect([...ACCEPTED_REPLY_STATUSES]).toEqual(['submitted', 'sent', 'delivered', 'read']);
    for (const not of ['failed', 'queued', 'received']) expect((ACCEPTED_REPLY_STATUSES as readonly string[]).includes(not)).toBe(false);
  });
  it('only a person counts: a background job (no user) does not', () => {
    expect(isEmployeeReply('9f1c0c8e-0000-4000-8000-000000000001')).toBe(true);
    expect(isEmployeeReply(null)).toBe(false);
    expect(isEmployeeReply(undefined)).toBe(false);
    expect(isEmployeeReply('')).toBe(false);
  });
});
