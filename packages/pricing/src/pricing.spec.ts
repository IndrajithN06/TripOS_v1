import { calculateQuote, diffResults, PricingError, RateSnapshot } from './index';

// Test-only rate card. Production values always come from tenant configuration.
const rate: RateSnapshot = {
  local8h80kmPrice: '3500', local4h40kmPrice: '2200',
  localSlabA: { hours: 8, km: 80 }, localSlabB: { hours: 4, km: 40 },
  extraHourRate: '300', extraKmRate: '23', outstationRatePerKm: '20', minKmPerDay: 300, driverBattaPerDay: '800',
};
const noTax = { enabled: false, ratePercent: '0', mode: 'exclusive' as const };

describe('local packages', () => {
  it('prices the documented 8hr/80km example with extras (4,675)', () => {
    const r = calculateQuote({ tripType: 'local_8h_80km', rate, hours: 10, km: 105, tax: noTax });
    expect(r.total).toBe('4675.00');
    expect(r.lines.map((l) => l.amount)).toEqual(['3500.00', '600.00', '575.00']);
  });
  it('charges only the base when within the package', () => {
    expect(calculateQuote({ tripType: 'local_4h_40km', rate, hours: 3, km: 30, tax: noTax }).total).toBe('2200.00');
  });
  it('honours negotiated overrides without mutating the snapshot', () => {
    const r = calculateQuote({ tripType: 'local_8h_80km', rate, overrides: { local8h80kmPrice: '3000' }, tax: noTax });
    expect(r.total).toBe('3000.00');
    expect(rate.local8h80kmPrice).toBe('3500');
  });
});

describe('outstation', () => {
  it('applies trip-wide minimum km and driver batta (20,400)', () => {
    const r = calculateQuote({ tripType: 'outstation', rate, days: 3, km: 750, tax: noTax });
    expect(r.billableKm).toBe('900');
    expect(r.total).toBe('20400.00');
  });
  it('uses actual km when above the minimum', () => {
    expect(calculateQuote({ tripType: 'outstation', rate, days: 2, km: 800, includeDriverBatta: false, tax: noTax }).total).toBe('16000.00');
  });
  it('applies the minimum per day independently in daily mode', () => {
    const r = calculateQuote({ tripType: 'outstation', rate, days: 2, minKmMode: 'daily', dailyKm: [100, 500], includeDriverBatta: false, tax: noTax });
    expect(r.billableKm).toBe('800');
  });
  it('rejects mismatched daily km list', () => {
    expect(() => calculateQuote({ tripType: 'outstation', rate, days: 2, minKmMode: 'daily', dailyKm: [100], tax: noTax })).toThrow(PricingError);
  });
});

describe('discount and tax', () => {
  const base = { tripType: 'local_8h_80km' as const, rate };
  it('applies discount before exclusive tax', () => {
    const r = calculateQuote({ ...base, discount: { type: 'amount', value: '500' }, tax: { enabled: true, ratePercent: '5', mode: 'exclusive' } });
    expect(r.taxableBase).toBe('3000.00');
    expect(r.tax).toBe('150.00');
    expect(r.total).toBe('3150.00');
  });
  it('extracts tax in inclusive mode without changing the total', () => {
    const r = calculateQuote({ ...base, tax: { enabled: true, ratePercent: '5', mode: 'inclusive' } });
    expect(r.total).toBe('3500.00');
    expect(r.tax).toBe('166.67');
  });
  it('percentage discounts round half-up', () => {
    const r = calculateQuote({ ...base, discount: { type: 'percent', value: '12.5' }, tax: noTax });
    expect(r.discount).toBe('437.50');
    expect(r.total).toBe('3062.50');
  });
  it('keeps non-taxable charges out of the tax base', () => {
    const r = calculateQuote({ ...base, extraCharges: [{ label: 'Toll', amount: '400', taxable: false }], tax: { enabled: true, ratePercent: '10', mode: 'exclusive' } });
    expect(r.taxableBase).toBe('3500.00');
    expect(r.total).toBe('4250.00');
  });
  it('rejects a discount above the subtotal and negative amounts', () => {
    expect(() => calculateQuote({ ...base, discount: { type: 'amount', value: '9999' }, tax: noTax })).toThrow(PricingError);
    expect(() => calculateQuote({ ...base, extraCharges: [{ label: 'x', amount: '-1' }], tax: noTax })).toThrow(PricingError);
    expect(() => calculateQuote({ ...base, discount: { type: 'percent', value: '101' }, tax: noTax })).toThrow(PricingError);
  });
  it('is free of floating point drift', () => {
    const r = calculateQuote({ ...base, extraCharges: [{ label: 'a', amount: '0.1' }, { label: 'b', amount: '0.2' }], tax: noTax });
    expect(r.total).toBe('3500.30');
  });
});

describe('diff', () => {
  it('reports total delta and changed lines', () => {
    const a = calculateQuote({ tripType: 'local_8h_80km', rate, tax: noTax });
    const b = calculateQuote({ tripType: 'local_8h_80km', rate, overrides: { local8h80kmPrice: '3200' }, tax: noTax });
    const d = diffResults(a, b);
    expect(d.totalDelta).toBe('-300.00');
    expect(d.changedLines).toHaveLength(1);
  });
});
