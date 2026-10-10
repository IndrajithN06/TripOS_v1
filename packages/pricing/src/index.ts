/**
 * Deterministic quotation pricing. Pure: no I/O, no clock, no globals.
 * All money is handled as decimal strings; the result is the only authoritative total.
 *
 * Policy (documented in docs/DECISIONS_AND_ASSUMPTIONS.md):
 *  - Every line is rounded half-up to 2 dp when it is produced.
 *  - Discount is applied BEFORE tax (tax is charged on the discounted taxable amount).
 *  - Only lines flagged `taxable` enter the tax base. A discount reduces the taxable base
 *    pro-rata (i.e. it is deducted from the taxable subtotal, capped at that subtotal).
 *  - taxMode "exclusive": tax is added on top. "inclusive": entered prices already contain tax,
 *    the tax portion is extracted and the grand total equals subtotal - discount.
 */
import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type TripType = 'local_8h_80km' | 'local_4h_40km' | 'outstation';
export type MinKmMode = 'trip' | 'daily';
export type TaxMode = 'exclusive' | 'inclusive';

/** Snapshot of a vehicle's rate card. All money fields are decimal strings. */
export interface RateSnapshot {
  local8h80kmPrice: string;
  local4h40kmPrice: string;
  localSlabA: { hours: number; km: number };
  localSlabB: { hours: number; km: number };
  extraHourRate: string;
  extraKmRate: string;
  outstationRatePerKm: string;
  minKmPerDay: number;
  driverBattaPerDay: string;
  defaults?: { toll?: string; parking?: string; permit?: string; interstateTax?: string };
}

export interface ExtraCharge {
  label: string;
  amount: string;
  taxable?: boolean;
}

export interface TaxConfig {
  enabled: boolean;
  /** percentage, e.g. "5" or "12.5". Never defaulted in code. */
  ratePercent: string;
  mode: TaxMode;
}

export interface DiscountInput {
  type: 'amount' | 'percent';
  value: string;
}

export interface PricingInput {
  tripType: TripType;
  rate: RateSnapshot;
  /** Optional negotiated overrides of rate-card values (same keys as RateSnapshot money fields). */
  overrides?: Partial<
    Pick<
      RateSnapshot,
      | 'local8h80kmPrice' | 'local4h40kmPrice' | 'extraHourRate' | 'extraKmRate'
      | 'outstationRatePerKm' | 'driverBattaPerDay'
    >
  > & { minKmPerDay?: number };
  /** Local: actual/estimated hours and km. */
  hours?: number;
  km?: number;
  /** Outstation: number of operational days and estimated km. */
  days?: number;
  minKmMode?: MinKmMode;
  dailyKm?: number[];
  includeDriverBatta?: boolean;
  extraCharges?: ExtraCharge[];
  discount?: DiscountInput;
  tax: TaxConfig;
}

export interface PriceLine {
  code: string;
  label: string;
  quantity: string;
  unitAmount: string;
  amount: string;
  taxable: boolean;
}

export interface PricingResult {
  currency: 'INR';
  lines: PriceLine[];
  subtotal: string;
  discount: string;
  taxableBase: string;
  tax: string;
  total: string;
  billableKm?: string;
  taxMode: TaxMode;
  taxRatePercent: string;
}

export class PricingError extends Error {}

const D = (v: Decimal.Value) => new Decimal(v);
const r2 = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const s = (v: Decimal) => v.toFixed(2);

function money(label: string, v: string | undefined): Decimal {
  if (v === undefined || v === '') return D(0);
  let d: Decimal;
  try { d = D(v); } catch { throw new PricingError(`${label} is not a valid number`); }
  if (!d.isFinite() || d.isNegative()) throw new PricingError(`${label} must be a non-negative amount`);
  return d;
}

function nonNeg(label: string, v: number | undefined, dflt = 0): Decimal {
  const n = v ?? dflt;
  if (!Number.isFinite(n) || n < 0) throw new PricingError(`${label} must be a non-negative number`);
  return D(n);
}

export function calculateQuote(input: PricingInput): PricingResult {
  const o = input.overrides ?? {};
  const rate = input.rate;
  const lines: PriceLine[] = [];
  const add = (code: string, label: string, qty: Decimal, unit: Decimal, taxable = true) => {
    lines.push({ code, label, quantity: qty.toString(), unitAmount: s(r2(unit)), amount: s(r2(qty.mul(unit))), taxable });
  };
  let billableKm: Decimal | undefined;

  const extraHourRate = money('extraHourRate', o.extraHourRate ?? rate.extraHourRate);
  const extraKmRate = money('extraKmRate', o.extraKmRate ?? rate.extraKmRate);

  if (input.tripType === 'local_8h_80km' || input.tripType === 'local_4h_40km') {
    const is8 = input.tripType === 'local_8h_80km';
    const slab = is8 ? rate.localSlabA : rate.localSlabB;
    const base = money('package price', is8 ? o.local8h80kmPrice ?? rate.local8h80kmPrice : o.local4h40kmPrice ?? rate.local4h40kmPrice);
    add('package', `Local package ${slab.hours} hr / ${slab.km} km`, D(1), base);
    const extraHours = Decimal.max(0, nonNeg('hours', input.hours, slab.hours).minus(slab.hours));
    const extraKm = Decimal.max(0, nonNeg('km', input.km, slab.km).minus(slab.km));
    if (extraHours.gt(0)) add('extra_hours', 'Extra hours', extraHours, extraHourRate);
    if (extraKm.gt(0)) add('extra_km', 'Extra kilometres', extraKm, extraKmRate);
  } else {
    const days = nonNeg('days', input.days, 1);
    if (!days.isInteger() || days.lt(1)) throw new PricingError('days must be a whole number of at least 1');
    const minPerDay = D(o.minKmPerDay ?? rate.minKmPerDay);
    if (minPerDay.isNegative()) throw new PricingError('minKmPerDay must be non-negative');
    if ((input.minKmMode ?? 'trip') === 'daily') {
      const dk = input.dailyKm ?? [];
      if (dk.length !== days.toNumber()) throw new PricingError('dailyKm must have one entry per day in daily minimum mode');
      billableKm = dk.reduce((a, k) => a.plus(Decimal.max(nonNeg('dailyKm', k), minPerDay)), D(0));
    } else {
      billableKm = Decimal.max(nonNeg('km', input.km), minPerDay.mul(days));
    }
    add('outstation_km', `Outstation distance (${billableKm.toString()} km billable)`, billableKm, money('outstation rate', o.outstationRatePerKm ?? rate.outstationRatePerKm));
    if (input.includeDriverBatta !== false) {
      const batta = money('driver batta', o.driverBattaPerDay ?? rate.driverBattaPerDay);
      if (batta.gt(0)) add('driver_batta', 'Driver batta (per day)', days, batta);
    }
  }

  for (const c of input.extraCharges ?? []) {
    if (!c.label?.trim()) throw new PricingError('Extra charge label is required');
    add('charge', c.label.trim(), D(1), money(`charge "${c.label}"`, c.amount), c.taxable ?? true);
  }

  const subtotal = lines.reduce((a, l) => a.plus(l.amount), D(0));
  const taxableSubtotal = lines.filter((l) => l.taxable).reduce((a, l) => a.plus(l.amount), D(0));

  let discount = D(0);
  if (input.discount) {
    const dv = money('discount', input.discount.value);
    if (input.discount.type === 'percent') {
      if (dv.gt(100)) throw new PricingError('Discount percentage cannot exceed 100');
      discount = r2(subtotal.mul(dv).div(100));
    } else discount = r2(dv);
    if (discount.gt(subtotal)) throw new PricingError('Discount cannot exceed the subtotal');
  }
  // Discount reduces the taxable base first (up to its size), preserving tax-free lines.
  const taxableBase = Decimal.max(0, taxableSubtotal.minus(discount));

  let tax = D(0);
  let total: Decimal;
  const rateP = input.tax.enabled ? money('tax rate', input.tax.ratePercent) : D(0);
  if (input.tax.enabled && rateP.gt(0)) {
    if (input.tax.mode === 'inclusive') {
      tax = r2(taxableBase.minus(taxableBase.div(D(1).plus(rateP.div(100)))));
      total = subtotal.minus(discount);
    } else {
      tax = r2(taxableBase.mul(rateP).div(100));
      total = subtotal.minus(discount).plus(tax);
    }
  } else total = subtotal.minus(discount);

  return {
    currency: 'INR',
    lines,
    subtotal: s(subtotal),
    discount: s(discount),
    taxableBase: s(r2(taxableBase)),
    tax: s(tax),
    total: s(r2(total)),
    billableKm: billableKm?.toString(),
    taxMode: input.tax.mode,
    taxRatePercent: rateP.toString(),
  };
}

export interface QuoteDiff {
  totalBefore: string;
  totalAfter: string;
  totalDelta: string;
  changedLines: { code: string; label: string; before: string | null; after: string | null }[];
}

/** Difference between two priced versions, for the "what changed" view. */
export function diffResults(before: PricingResult, after: PricingResult): QuoteDiff {
  const key = (l: PriceLine, i: number) => `${l.code}:${l.label}:${i}`;
  const b = new Map(before.lines.map((l, i) => [key(l, i), l]));
  const a = new Map(after.lines.map((l, i) => [key(l, i), l]));
  const keys = new Set([...b.keys(), ...a.keys()]);
  const changedLines: QuoteDiff['changedLines'] = [];
  for (const k of keys) {
    const x = b.get(k), y = a.get(k);
    if (x?.amount !== y?.amount) changedLines.push({ code: (x ?? y)!.code, label: (x ?? y)!.label, before: x?.amount ?? null, after: y?.amount ?? null });
  }
  return {
    totalBefore: before.total,
    totalAfter: after.total,
    totalDelta: s(D(after.total).minus(before.total)),
    changedLines,
  };
}
