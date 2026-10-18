import { dayLabel, initials, tickFor } from './inbox-view';

describe('tickFor (delivery state -> tick)', () => {
  it('shows blue "read" ticks only for the exact status read', () => {
    expect(tickFor('read').kind).toBe('read');
    for (const s of ['queued', 'submitted', 'sent', 'delivered', 'failed', 'received', 'READ', 'read ', '', undefined, null]) expect(tickFor(s as any).kind).not.toBe('read');
  });
  it('maps each known state to its own tick', () => {
    expect(tickFor('queued').kind).toBe('pending');
    expect(tickFor('sent').kind).toBe('sent');
    expect(tickFor('delivered').kind).toBe('delivered');
    expect(tickFor('failed').kind).toBe('failed');
  });
  it('does not present a merely submitted message as sent or delivered', () => {
    expect(tickFor('submitted').kind).toBe('pending');
    expect(tickFor('submitted').label).toMatch(/awaiting confirmation/i);
  });
  it('returns "none" for unknown or inbound statuses so the caller can show the raw status instead of guessing', () => {
    expect(tickFor('received').kind).toBe('none');
    expect(tickFor('some_new_state')).toEqual({ kind: 'none', label: 'some_new_state' });
    expect(tickFor(undefined)).toEqual({ kind: 'none', label: '' });
  });
});

describe('initials', () => {
  it('uses the first letters of the first and last word', () => {
    expect(initials('Rahul Kumar')).toBe('RK');
    expect(initials('  priya  ')).toBe('P');
    expect(initials('Anil Kumar Sharma')).toBe('AS');
  });
  it('falls back to ? for empty or symbol-only names and copes with null', () => {
    expect(initials('')).toBe('?');
    expect(initials(null)).toBe('?');
    expect(initials('+91 99000')).toBe('99');
    expect(initials('---')).toBe('?');
  });
});

describe('dayLabel (agency timezone)', () => {
  const now = new Date('2026-10-18T10:00:00Z'); // 15:30 on 18 Oct in IST
  it('says Today / Yesterday relative to the agency timezone', () => {
    expect(dayLabel('2026-10-18T03:00:00Z', 'Asia/Kolkata', now)).toBe('Today');
    expect(dayLabel('2026-10-17T12:00:00Z', 'Asia/Kolkata', now)).toBe('Yesterday');
  });
  it('uses the agency day, not the UTC day, at the boundary', () => {
    // 19:00 UTC on 17 Oct is 00:30 on 18 Oct in IST -> still "Today" for the agency.
    expect(dayLabel('2026-10-17T19:00:00Z', 'Asia/Kolkata', now)).toBe('Today');
    expect(dayLabel('2026-10-17T19:00:00Z', 'UTC', now)).toBe('Yesterday');
  });
  it('prints a short date for older messages', () => {
    expect(dayLabel('2026-10-10T08:00:00Z', 'Asia/Kolkata', now)).toMatch(/10 Oct 2026/);
  });
});
