import { durationProblem, extractToPrefill, MAX_DAYS, NEW_QUOTE_DAYS, storedDaysField } from './quote-prefill';

// The two rules behind "an unknown outstation duration is never silently priced as one day":
//  1. extractToPrefill leaves an unknown duration EMPTY (it used to become "1");
//  2. durationProblem says an outstation quote cannot be priced, saved, previewed or sent until its duration is valid.
// The quote form (components/QuoteBuilder.tsx) uses rule 2 for every one of those actions; local packages are never blocked.

const trip = (over: Record<string, unknown> = {}) => ({ fields: { pickupLocation: 'Bengaluru', destination: 'Coorg', passengers: 5, days: 3, tripType: 'outstation', ...over } });

describe('extractToPrefill: trip duration', () => {
  it.each([
    ['null (the customer did not say)', null],
    ['undefined', undefined],
    ['0', 0],
    ['a negative number', -2],
    ['a fraction', 2.5],
    ['NaN', NaN],
    ['more than the server accepts', MAX_DAYS + 1],
    ['text instead of a number', '3'],
  ])('an unknown or unusable duration stays empty, never "1": %s', (_label, days) => {
    expect(extractToPrefill(trip({ days }) as never).days).toBe('');
  });

  it.each([[1, '1'], [3, '3'], [10, '10'], [MAX_DAYS, String(MAX_DAYS)]])('a stated duration is kept: %d', (days, expected) => {
    expect(extractToPrefill(trip({ days })).days).toBe(expected);
  });

  it('always carries a "days" key, so spreading it over the form defaults can never bring a default number back', () => {
    const unknown = extractToPrefill(trip({ days: null }));
    expect(Object.prototype.hasOwnProperty.call(unknown, 'days')).toBe(true);
    // The quote form starts from { ...defaults, ...prefill }; its own default for days is '1'.
    const formDefaults: { days: string } = { days: '1' };
    expect({ ...formDefaults, ...unknown }.days).toBe('');
    expect({ ...formDefaults, ...extractToPrefill(trip({ days: 4 })) }.days).toBe('4');
  });
});

describe('extractToPrefill: everything else is unchanged', () => {
  it('maps a complete extraction', () => {
    expect(extractToPrefill(trip())).toEqual({ pickupLocation: 'Bengaluru', destinations: 'Coorg', passengers: '5', days: '3', tripType: 'outstation' });
  });
  it('maps unstated places to empty text, unstated passengers to 4, and an unknown trip type to outstation (as before)', () => {
    expect(extractToPrefill(trip({ pickupLocation: null, destination: null, passengers: null, days: null, tripType: null }))).toEqual({
      pickupLocation: '', destinations: '', passengers: '4', days: '', tripType: 'outstation',
    });
  });
  it('maps a local trip to the 8 hr / 80 km package', () => {
    expect(extractToPrefill(trip({ tripType: 'local' })).tripType).toBe('local_8h_80km');
    expect(extractToPrefill(trip({ tripType: 'outstation' })).tripType).toBe('outstation');
  });
});

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

describe('an AI extraction with no duration cannot become a priced quote until staff provide one', () => {
  it('outstation, duration unknown: prefilled empty and blocked until a valid number is entered', () => {
    const p = extractToPrefill(trip({ days: null }));
    expect(p.tripType).toBe('outstation');
    expect(durationProblem(p.tripType, p.days)).toMatch(/Enter the number of days/);
    expect(durationProblem(p.tripType, '2')).toBeNull(); // staff typed 2
    expect(durationProblem(p.tripType, '0')).not.toBeNull(); // 0 is still not a duration
  });

  it('outstation, duration stated: not blocked', () => {
    const p = extractToPrefill(trip({ days: 3 }));
    expect(durationProblem(p.tripType, p.days)).toBeNull();
  });

  it('local trip, duration unknown: not blocked (local packages are priced by hours and km)', () => {
    const p = extractToPrefill(trip({ tripType: 'local', days: null }));
    expect(p.tripType).toBe('local_8h_80km');
    expect(p.days).toBe('');
    expect(durationProblem(p.tripType, p.days)).toBeNull();
  });

  it('switching an unknown-duration quote to a local package unblocks it, and back to outstation blocks it again', () => {
    const p = extractToPrefill(trip({ days: null }));
    expect(durationProblem('local_4h_40km', p.days)).toBeNull();
    expect(durationProblem('outstation', p.days)).not.toBeNull();
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
