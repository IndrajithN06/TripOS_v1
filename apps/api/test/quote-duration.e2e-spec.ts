import { INestApplication } from '@nestjs/common';
import { Db } from '../src/db/db.service';
import { boot, Client, createVehicle, onboard, superAdmin, Tenant } from './helpers';

/**
 * An outstation trip is priced by its days (minimum km per day x days, driver batta per day). The server never invents a duration:
 * it takes explicit `days`, or derives them from a return date and time, or refuses with 400 duration_required. Local packages
 * are priced by hours and km and are never affected.
 * Rate card used by createVehicle: Rs 20/km, 300 km/day minimum, batta Rs 800/day. With 750 km: 1 day = 15,800; 2 = 16,600; 3 = 20,400.
 */
describe('Quote duration: required for outstation trips, enforced by the server', () => {
  let app: INestApplication, sa: Client, T: Tenant, db: Db, vehicle: { id: string }, customerId: string;

  const P = '2030-01-10T04:30:00.000Z';
  const H = 3_600_000, MIN = 60_000, DAY = 24 * H;
  const at = (ms: number) => new Date(Date.parse(P) + ms).toISOString();
  const TOTAL: Record<number, string> = { 1: '15800.00', 2: '16600.00', 3: '20400.00' };

  const outstation = (over: Record<string, unknown> = {}) => ({ tripType: 'outstation', pickupAt: P, pickupLocation: 'Bangalore', destinations: ['Coorg'], passengers: 5, km: 750, ...over });
  const local = (tripType: string, over: Record<string, unknown> = {}) => ({ tripType, pickupAt: P, pickupLocation: 'Bangalore', destinations: ['Coorg'], passengers: 5, ...over });
  const calc = (trip: object, who: Client = T.sales) => who.post('/quotes/calculate', { vehicleTypeId: vehicle.id, trip });
  const create = (trip: object) => T.sales.post('/quotes', { customerId, vehicleTypeId: vehicle.id, trip, imageAssetIds: [] });
  const quoteCount = () => db.system((tx) => tx.quote.count({ where: { agencyId: T.agencyId } }));
  const quoteSeq = () => db.system((tx) => tx.agency.findUniqueOrThrow({ where: { id: T.agencyId } })).then((a) => a.quoteSeq);
  const versionsOf = (quoteId: string) => db.system((tx) => tx.quoteVersion.findMany({ where: { quoteId }, orderBy: { versionNumber: 'asc' } }));

  beforeAll(async () => {
    app = await boot();
    db = app.get(Db);
    sa = await superAdmin(app);
    T = await onboard(app, sa, 'Duration');
    vehicle = await createVehicle(T.admin, 'DurationCar', 0);
    customerId = (await T.admin.post('/customers', { name: 'Duration Customer', phone: `+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}` })).body.id;
    expect(customerId).toBeTruthy();
  });
  afterAll(async () => { await app.close(); });

  describe('pricing preview (POST /quotes/calculate)', () => {
    it.each([
      ['no days and no return date', outstation()],
      ['an explicit null return date', outstation({ returnAt: null })],
    ])('refuses %s with 400 duration_required, and prices nothing', async (_label, trip) => {
      const r = await calc(trip);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('duration_required');
      expect(r.body.error.message).toMatch(/number of days/i);
      expect(r.body.total).toBeUndefined();
      expect(r.body.lines).toBeUndefined();
    });

    it('refuses for an admin too (the rule is not role-dependent)', async () => {
      const r = await calc(outstation(), T.admin);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('duration_required');
    });

    it('prices an explicit number of days exactly as before', async () => {
      const three = await calc(outstation({ days: 3 }));
      expect(three.status).toBe(201);
      expect(three.body.total).toBe(TOTAL[3]);
      expect(three.body.lines.find((l: any) => l.code === 'driver_batta').quantity).toBe('3');
      expect((await calc(outstation({ days: 1 }))).body.total).toBe(TOTAL[1]);
    });

    it.each([
      ['exactly 24 hours', DAY, 1],
      ['24 hours and 1 minute', DAY + MIN, 2],
      ['exactly 48 hours', 2 * DAY, 2],
      ['48 hours and 1 minute', 2 * DAY + MIN, 3],
      ['50 hours', 50 * H, 3],
      ['a few hours later (minimum 1 day)', 5 * H, 1],
      ['a return before the pickup (minimum 1 day)', -5 * H, 1],
    ])('derives the duration from a return date alone: %s -> %d day(s)', async (_label, ms, days) => {
      const r = await calc(outstation({ returnAt: at(ms) }));
      expect(r.status).toBe(201);
      expect(r.body.total).toBe(TOTAL[days]);
      expect(r.body.lines.find((l: any) => l.code === 'driver_batta').quantity).toBe(String(days));
    });

    it('an explicit number of days wins over a return date', async () => {
      expect((await calc(outstation({ days: 1, returnAt: at(5 * DAY) }))).body.total).toBe(TOTAL[1]);
      expect((await calc(outstation({ days: 3, returnAt: at(DAY) }))).body.total).toBe(TOTAL[3]);
    });

    it('local packages are never blocked, with or without days or a return date', async () => {
      const r8 = await calc(local('local_8h_80km'));
      expect(r8.status).toBe(201);
      expect(r8.body.total).toBe('3500.00');
      const r4 = await calc(local('local_4h_40km'));
      expect(r4.status).toBe(201);
      expect(r4.body.total).toBe('2200.00');
      // A stray days value or return date on a local package changes nothing.
      expect((await calc(local('local_8h_80km', { days: 7, returnAt: at(3 * DAY) }))).body.total).toBe('3500.00');
    });

    it('is checked before any other work: a missing duration is reported even beside another problem', async () => {
      const r = await T.sales.post('/quotes/calculate', { vehicleTypeId: '00000000-0000-4000-8000-000000000000', trip: outstation() });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('duration_required');
    });
  });

  describe('saving (POST /quotes)', () => {
    it('refuses an outstation quote without a duration: nothing is created and no quote number is used', async () => {
      const before = { quotes: await quoteCount(), seq: await quoteSeq() };
      const r = await create(outstation());
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('duration_required');
      expect(await quoteCount()).toBe(before.quotes);
      expect(await quoteSeq()).toBe(before.seq);
      // The next valid quote takes the very next number: no gap was burnt by the refused attempt.
      const ok = await create(outstation({ days: 3 }));
      expect(ok.status).toBe(201);
      expect(await quoteSeq()).toBe(before.seq + 1);
    });

    it('stores an outstation quote that has days, and one that has only a return date (priced from the derived days)', async () => {
      const withDays = await create(outstation({ days: 3 }));
      expect(withDays.status).toBe(201);
      const withReturn = await create(outstation({ returnAt: at(50 * H) }));
      expect(withReturn.status).toBe(201);
      for (const q of [withDays, withReturn]) {
        const [v] = await versionsOf(q.body.id);
        expect(v.total.toFixed(2)).toBe(TOTAL[3]);
      }
    });

    it('stores a local-package quote with no duration', async () => {
      const r = await create(local('local_8h_80km'));
      expect(r.status).toBe(201);
      expect((await versionsOf(r.body.id))[0].total.toFixed(2)).toBe('3500.00');
    });
  });

  describe('editing and re-quoting', () => {
    it('editing a duration-less local draft into an outstation trip is refused, and the draft is left exactly as it was', async () => {
      const q = await create(local('local_8h_80km'));
      const before = (await versionsOf(q.body.id))[0];
      const r = await T.sales.patch(`/quotes/${q.body.id}/draft`, { trip: outstation() });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('duration_required');
      const after = (await versionsOf(q.body.id))[0];
      expect((after.trip as any).tripType).toBe('local_8h_80km');
      expect(after.total.toString()).toBe(before.total.toString());
      // Giving a duration in the same edit works.
      const fixed = await T.sales.patch(`/quotes/${q.body.id}/draft`, { trip: outstation({ days: 3 }) });
      expect(fixed.status).toBe(200);
      expect((await versionsOf(q.body.id))[0].total.toFixed(2)).toBe(TOTAL[3]);
    });
  });

  describe('older data without a stored duration (simulated legacy rows)', () => {
    /** A sent outstation version that has neither days nor a return date, as an older client could have stored. */
    async function legacySentOutstationQuote() {
      const q = await create(local('local_8h_80km'));
      const outstationTrip = (t: any) => { const { days: _d, returnAt: _r, ...rest } = t; return { ...rest, tripType: 'outstation' }; };
      await db.system(async (tx) => {
        const v = await tx.quoteVersion.findFirstOrThrow({ where: { quoteId: q.body.id } });
        const pi: any = v.pricingInput;
        await tx.quoteVersion.update({
          where: { id: v.id },
          data: { status: 'sent', sentAt: new Date(), trip: outstationTrip(v.trip) as any, pricingInput: { ...pi, input: { ...pi.input, trip: outstationTrip(pi.input.trip) } } as any },
        });
        await tx.quote.update({ where: { id: q.body.id }, data: { status: 'sent' } });
      });
      return q.body.id as string;
    }

    it('can still be opened and previewed (reading never recomputes a price)', async () => {
      const id = await legacySentOutstationQuote();
      expect((await T.sales.get(`/quotes/${id}`)).status).toBe(200);
      expect((await T.sales.get(`/quotes/${id}/versions/1/preview`)).status).toBe(200);
    });

    it('cannot be duplicated until a duration exists: nothing is created', async () => {
      const id = await legacySentOutstationQuote();
      const before = await quoteCount();
      const r = await T.sales.post(`/quotes/${id}/duplicate`);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('duration_required');
      expect(await quoteCount()).toBe(before);
    });

    it('cannot be re-quoted without a duration, but can once one is supplied; the sent version is never touched', async () => {
      const id = await legacySentOutstationQuote();
      const sentBefore = (await versionsOf(id))[0];
      const refused = await T.sales.post(`/quotes/${id}/versions`, {});
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('duration_required');
      expect(await versionsOf(id)).toHaveLength(1);

      const ok = await T.sales.post(`/quotes/${id}/versions`, { trip: outstation({ days: 3 }) });
      expect(ok.status).toBe(201);
      const versions = await versionsOf(id);
      expect(versions).toHaveLength(2);
      expect(versions[1].total.toFixed(2)).toBe(TOTAL[3]);
      expect(versions[0].total.toString()).toBe(sentBefore.total.toString());
      expect(JSON.stringify(versions[0].trip)).toBe(JSON.stringify(sentBefore.trip));
    });
  });
});
