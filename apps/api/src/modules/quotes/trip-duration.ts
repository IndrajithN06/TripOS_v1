import { BadRequestException } from '@nestjs/common';

/** Error code returned when an outstation trip has no usable duration. */
export const DURATION_REQUIRED = 'duration_required';

const DAY_MS = 86_400_000;

/**
 * Days between a pickup and a return time: elapsed time in 24-hour blocks, rounded up, never less than 1.
 * This is the same rule the quote form uses to fill in "Days" when a return date and time are entered, so the two always agree.
 */
export function daysFromDates(pickupAt: string, returnAt: string): number {
  return Math.max(1, Math.ceil((new Date(returnAt).getTime() - new Date(pickupAt).getTime()) / DAY_MS));
}

/**
 * The number of billable days of an OUTSTATION trip, which drives its minimum km (days x minimum km per day) and its driver batta.
 *  - an explicit `days` always wins;
 *  - otherwise a return date and time determines it (daysFromDates);
 *  - with neither there is nothing to price: 400 duration_required. There is no silent default (it used to be 1 day, which
 *    quietly under-prices a multi-day trip).
 * Local packages are priced by hours and kilometres, so callers must not use this for them.
 */
export function outstationDays(trip: { days?: number | null; pickupAt: string; returnAt?: string | null }): number {
  if (trip.days != null) return trip.days;
  if (trip.returnAt) return daysFromDates(trip.pickupAt, trip.returnAt);
  throw new BadRequestException({
    code: DURATION_REQUIRED,
    message: 'Enter the number of days for this outstation trip, or a return date and time. The price depends on it.',
  });
}
