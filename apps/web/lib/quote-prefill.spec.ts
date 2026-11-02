import { durationProblem, MAX_DAYS, NEW_QUOTE_DAYS, storedDaysField } from './quote-prefill';

// The rule behind "an unknown outstation duration is never silently priced as one day": durationProblem says an outstation quote
// cannot be priced, saved, previewed or sent until its duration is valid. The quote form (components/QuoteBuilder.tsx) uses it for
// every one of those actions; local packages are never blocked.

describe('durationProblem', () => {
  it.each(['local_8h_80km', 'local_4h_40km'])('never blocks the local package %s, whatever the days field holds', (tripType) => {
    for (const days of ['', '  ', '0', '-3', '2.5', 'abc', '999', '3']) expect(durationProblem(tripType, days)).toBeNull();
  });

  it.each(['', ' ', '   ', '\t'])('an outstation trip with an empty days field (%j) is blocked, with a message that asks for it', (days) => {
    const msg = durationProblem('outstation', days);
    expect(msg).toMatch(/Enter the number of days/);
    expect(msg).toMatch(/price depends on it/);
  });

  it.each(['0', '-1', '-3', '2.5', '1.5', 'abc', '12abc', 'Infinity', 'NaN', String(MAX_DAYS + 1), '100', '9999'])('an outstation trip with the invalid days "%s" is blocked', (days) => {
    expect(durationProblem('outstation', days)).toBe(`Days must be a whole number from 1 to ${MAX_DAYS}.`);
  });

  it.each(['1', '2', '3', '10', String(MAX_DAYS), ' 3 ', '03'])('an outstation trip with the valid days "%s" is allowed', (days) => {
    expect(durationProblem('outstation', days)).toBeNull();
  });

  it('missing and invalid are different messages, so staff know what to fix', () => {
    expect(durationProblem('outstation', '')).not.toBe(durationProblem('outstation', '0'));
  });
});

describe('a brand-new quote never guesses a duration', () => {
  it('starts with an empty Days field, and is blocked as outstation until staff enter one', () => {
    expect(NEW_QUOTE_DAYS).toBe('');
    expect(durationProblem('outstation', NEW_QUOTE_DAYS)).toMatch(/Enter the number of days/);
    expect(durationProblem('outstation', '3')).toBeNull();
  });

  it('a new local-package quote is not blocked by the empty Days field', () => {
    expect(durationProblem('local_8h_80km', NEW_QUOTE_DAYS)).toBeNull();
    expect(durationProblem('local_4h_40km', NEW_QUOTE_DAYS)).toBeNull();
  });
});

describe('storedDaysField: reopening an existing quote', () => {
  it.each([[1, '1'], [3, '3'], [MAX_DAYS, String(MAX_DAYS)]])('shows the stored duration %d', (days, expected) => {
    expect(storedDaysField(days)).toBe(expected);
  });

  it.each([[undefined], [null], [0], [-1], [2.5], [MAX_DAYS + 1], [NaN]])('shows nothing, never 1, when the stored value is %p', (days) => {
    expect(storedDaysField(days as never)).toBe('');
  });

  it('an older quote saved without days opens blank and is blocked (as outstation) until a duration is entered or derived from dates', () => {
    expect(durationProblem('outstation', storedDaysField(undefined))).toMatch(/Enter the number of days/);
  });
});
