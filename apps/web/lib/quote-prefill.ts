/**
 * Pure helpers (no DOM, no React) for starting a quote from an AI trip extraction, and for the rule that an outstation quote needs a
 * real trip duration before it can be priced, saved, previewed or sent.
 *
 * Why: the price of an outstation trip is driven by its number of days (minimum km per day x days, and driver batta per day). A
 * duration the customer never stated used to be turned into "1" without a word, which quietly under-prices multi-day trips. An
 * unknown duration now stays empty, and the quote form asks for it.
 */

/** The server accepts 1-60 days (tripSchema in apps/api/src/modules/quotes/quotes.service.ts). */
export const MIN_DAYS = 1;
export const MAX_DAYS = 60;

/** The trip fields an AI extraction returns. A value the customer did not state is null. */
export interface ExtractedTrip {
  pickupLocation?: string | null;
  destination?: string | null;
  passengers?: number | null;
  days?: number | null;
  tripType?: string | null;
}

/** The part of the quote form that an extraction pre-fills (every value is a form string). */
export interface QuotePrefill {
  pickupLocation: string;
  destinations: string;
  passengers: string;
  days: string;
  tripType: 'local_8h_80km' | 'outstation';
}

const isDays = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= MIN_DAYS && v <= MAX_DAYS;

/** A brand-new quote never guesses a duration: the Days field starts empty and the form asks for it. */
export const NEW_QUOTE_DAYS = '';

/**
 * The Days field for a quote that already exists: the stored number, or empty when none was stored. Never a guessed 1.
 * (When a return date and time are present, the form fills Days in from them, as before.)
 */
export function storedDaysField(days: number | null | undefined): string {
  return isDays(days) ? String(days) : '';
}

/**
 * Turns an extraction into the quote form's starting values.
 *
 * `days` is ALWAYS present in the result (the form spreads this object over its defaults, so an omitted key would let the form's own
 * default come back). An unknown duration is the empty string, never a number: the form must ask for it.
 * The other mappings are unchanged from before: unstated passengers start at 4, and anything that is not a local trip starts as outstation.
 */
export function extractToPrefill(output: { fields: ExtractedTrip }): QuotePrefill {
  const f = output.fields;
  return {
    pickupLocation: f.pickupLocation ?? '',
    destinations: f.destination ?? '',
    passengers: f.passengers ? String(f.passengers) : '4',
    days: isDays(f.days) ? String(f.days) : '',
    tripType: f.tripType === 'local' ? 'local_8h_80km' : 'outstation',
  };
}

/**
 * Why an outstation quote cannot be priced yet, or null when its duration is fine.
 * Only outstation trips are priced by days; local packages (8 h / 80 km, 4 h / 40 km) are priced by hours and km, so they are never blocked.
 */
export function durationProblem(tripType: string, days: string): string | null {
  if (tripType !== 'outstation') return null;
  const text = days.trim();
  if (text === '') return 'Enter the number of days for this outstation trip. The price depends on it.';
  const n = Number(text);
  if (!Number.isInteger(n) || n < MIN_DAYS || n > MAX_DAYS) return `Days must be a whole number from ${MIN_DAYS} to ${MAX_DAYS}.`;
  return null;
}
