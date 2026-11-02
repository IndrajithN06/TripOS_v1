/**
 * Pure helpers (no DOM, no React) for the rule that an outstation quote needs a real trip duration before it can be priced, saved,
 * previewed or sent.
 *
 * Why: the price of an outstation trip is driven by its number of days (minimum km per day x days, and driver batta per day). A
 * duration the customer never stated used to be turned into "1" without a word, which quietly under-prices multi-day trips. An
 * unknown duration now stays empty, and the quote form asks for it.
 */

/** The server accepts 1-60 days (tripSchema in apps/api/src/modules/quotes/quotes.service.ts). */
export const MIN_DAYS = 1;
export const MAX_DAYS = 60;

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
