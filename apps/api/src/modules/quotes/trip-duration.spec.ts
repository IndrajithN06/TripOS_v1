import { BadRequestException } from '@nestjs/common';
import { daysFromDates, DURATION_REQUIRED, outstationDays } from './trip-duration';

// The one rule for the billable days of an outstation trip: an explicit number wins; otherwise a return date and time decides it
// (elapsed time in 24-hour blocks, rounded up, at least 1); with neither there is no duration and nothing may be priced.

const P = '2026-11-01T10:00:00.000Z';
const plus = (ms: number) => new Date(new Date(P).getTime() + ms).toISOString();
const H = 3_600_000, MIN = 60_000, DAY = 24 * H;

function problem(fn: () => unknown): BadRequestException {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(BadRequestException); return e as BadRequestException; }
  throw new Error('expected a BadRequestException');
}

describe('outstationDays: an explicit number of days', () => {
  it.each([1, 2, 3, 10, 60])('is used as given: %d', (days) => {
    expect(outstationDays({ days, pickupAt: P })).toBe(days);
  });

  it('wins over a return date, in both directions', () => {
    expect(outstationDays({ days: 5, pickupAt: P, returnAt: plus(DAY) })).toBe(5); // return date says 1
    expect(outstationDays({ days: 1, pickupAt: P, returnAt: plus(10 * DAY) })).toBe(1); // return date says 10
  });
});

describe('outstationDays: derived from a return date and time (round up, 24-hour blocks, minimum 1)', () => {
  it.each([
    ['exactly 24 hours', DAY, 1],
    ['24 hours and 1 millisecond', DAY + 1, 2],
    ['47 hours 59 minutes', 47 * H + 59 * MIN, 2],
    ['exactly 48 hours', 2 * DAY, 2],
    ['48 hours and 1 minute', 2 * DAY + MIN, 3],
    ['50 hours', 50 * H, 3],
    ['64 hours', 64 * H, 3],
    ['exactly 7 days', 7 * DAY, 7],
    ['7 days and 1 millisecond', 7 * DAY + 1, 8],
    ['30 days', 30 * DAY, 30],
  ])('%s -> %d day(s)', (_label, ms, days) => {
    expect(outstationDays({ pickupAt: P, returnAt: plus(ms) })).toBe(days);
  });

  it.each([
    ['the same instant', 0],
    ['1 minute later', MIN],
    ['a few hours later', 5 * H],
    ['a return before the pickup', -3 * H],
    ['a return a week before the pickup', -7 * DAY],
  ])('never less than 1 day: %s', (_label, ms) => {
    expect(outstationDays({ pickupAt: P, returnAt: plus(ms) })).toBe(1);
  });

  it('counts elapsed 24-hour blocks, not calendar days (a daylight-saving day has 23 hours)', () => {
    // New York clocks go forward on 8 March 2026: 12:00 the day before to 12:00 that day is only 23 hours.
    expect(daysFromDates('2026-03-07T12:00:00-05:00', '2026-03-08T12:00:00-04:00')).toBe(1);
    // Overnight within one calendar day boundary is still 1 day, though it touches two dates.
    expect(daysFromDates('2026-11-01T22:00:00+05:30', '2026-11-02T06:00:00+05:30')).toBe(1);
    // Two dates 48 hours apart is 2 days, though it touches three dates.
    expect(daysFromDates('2026-11-01T10:00:00+05:30', '2026-11-03T10:00:00+05:30')).toBe(2);
  });

  it('is not affected by the time zone the instants are written in', () => {
    const a = daysFromDates('2026-11-01T10:00:00+05:30', '2026-11-04T09:00:00+05:30');
    const b = daysFromDates('2026-11-01T04:30:00Z', '2026-11-04T03:30:00Z');
    expect(a).toBe(3);
    expect(b).toBe(3);
  });
});

describe('outstationDays: no duration at all is an error, never a default', () => {
  it.each([
    ['no days, no return date', { pickupAt: P }],
    ['null days, null return date', { days: null, pickupAt: P, returnAt: null }],
    ['undefined days, null return date', { days: undefined, pickupAt: P, returnAt: null }],
    ['an empty return date', { pickupAt: P, returnAt: '' }],
  ])('%s -> 400 duration_required', (_label, trip) => {
    const e = problem(() => outstationDays(trip));
    expect(e.getStatus()).toBe(400);
    const body = e.getResponse() as { code: string; message: string };
    expect(body.code).toBe(DURATION_REQUIRED);
    expect(body.code).toBe('duration_required');
    expect(body.message).toMatch(/number of days/i);
    expect(body.message).toMatch(/return date/i);
  });
});
