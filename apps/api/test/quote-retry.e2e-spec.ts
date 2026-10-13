import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { Db } from '../src/db/db.service';
import { configureApp } from '../src/main';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { AUTO_RETRY_MAX_ATTEMPTS } from '../src/modules/quotes/retry-policy';
import { WHATSAPP } from '../src/providers/whatsapp/whatsapp';
import { authError, FakeCloud, rateLimitError } from './fake-cloud';
import { Client, createVehicle, onboard, superAdmin, Tenant, tripOutstation, uid } from './helpers';

/**
 * Quotation delivery retries against a fake Meta provider.
 * Regression for the runaway-retry incident: an expired token caused a retry job every minute, without end.
 */
describe('Quote delivery: bounded, classified automatic retries', () => {
  let app: INestApplication, sa: Client, T: Tenant, fake: FakeCloud, vehicle: Awaited<ReturnType<typeof createVehicle>>, convId: string;
  let db: Db, jobs: JobsService;
  const phone = `PN-${uid()}`, waba = `WABA-${uid()}`;

  beforeAll(async () => {
    fake = new FakeCloud();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(WHATSAPP).useValue(fake).compile();
    app = configureApp(mod.createNestApplication({ bodyParser: false, logger: false }));
    await app.init();
    db = app.get(Db); jobs = app.get(JobsService);
    sa = await superAdmin(app);
    T = await onboard(app, sa, 'Retry', { connect: false });
    expect((await T.admin.post('/agency/whatsapp/connect', { displayName: 'Retry line', wabaId: waba, phoneNumberId: phone, accessToken: 'EAAG-fake-token-value' })).status).toBe(201);
    vehicle = await createVehicle(T.admin, 'RetryCar', 2);
    await request(app.getHttpServer()).post('/webhooks/whatsapp').send({ entry: [{ id: waba, changes: [{ field: 'messages', value: { metadata: { phone_number_id: phone }, contacts: [{ wa_id: '919700000777', profile: { name: 'Cust' } }], messages: [{ id: `in-${uid()}`, from: '919700000777', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' } }] } }] }] });
    convId = (await T.admin.get('/inbox/conversations')).body.items[0].id;
    // A noisy neighbour: a pile of overdue jobs from other agencies. Our retries must still run and stay bounded.
    await db.system((tx) => tx.job.createMany({ data: Array.from({ length: 12 }, () => ({ agencyId: randomUUID(), type: 'quote.retry', payload: { versionId: randomUUID() }, runAt: new Date(Date.now() - 3_600_000) })) }));
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { fake.sendError = undefined; fake.attempted.length = 0; fake.delivered.length = 0; });

  const newQuote = async (photos = 1) => (await T.admin.post('/quotes', { conversationId: convId, vehicleTypeId: vehicle.id, trip: tripOutstation(), imageAssetIds: vehicle.images.slice(0, photos).map((i: any) => i.assetId) })).body;
  const attemptsOf = (quoteId: string) => db.tenant(T.agencyId, async (tx) => {
    const q = await tx.quote.findFirstOrThrow({ where: { id: quoteId } });
    return tx.quoteSendAttempt.findMany({ where: { quoteVersionId: q.currentVersionId! }, orderBy: { createdAt: 'asc' } });
  });
  const jobRows = () => db.tenant(T.agencyId, (tx) => tx.job.findMany({ where: { type: 'quote.retry' }, orderBy: { createdAt: 'asc' } }));
  /** Makes every queued retry due now (instead of waiting minutes) and lets the worker run them. */
  // Runs ONLY this agency's queued retries: other pending jobs in the shared test database are parked for a day so the
  // worker tick (which handles the whole queue, oldest first, max 10) cannot be crowded out by unrelated jobs.
  // (due time is set a minute in the past so a small clock difference between this process and the database cannot hide it)
  const runDueJobs = async () => {
    await db.system(async (tx) => {
      await tx.job.updateMany({ where: { agencyId: { not: T.agencyId }, status: 'pending' }, data: { runAt: new Date(Date.now() + 86_400_000) } });
      await tx.job.updateMany({ where: { agencyId: T.agencyId, status: 'pending' }, data: { runAt: new Date(Date.now() - 60_000) } });
    });
    return jobs.tick();
  };
  const pendingJobs = async () => (await jobRows()).filter((j) => j.status === 'pending');
  const refreshConnection = () => T.admin.post('/agency/whatsapp/refresh');
  const send = (q: any) => T.admin.post(`/quotes/${q.id}/versions/1/send`);
  const retry = (q: any) => T.admin.post(`/quotes/${q.id}/versions/1/retry`);

  it('expired credentials are NOT retried automatically; recovery after reconnect is manual and sends each item exactly once', async () => {
    const q = await newQuote(1);
    const before = (await jobRows()).length;
    fake.sendError = authError();
    const r = await send(q);

    expect(r.body).toMatchObject({ versionStatus: 'failed', quoteStatus: 'send_failed', retryable: false, nextRetryMs: null });
    expect(fake.attempted).toEqual(['text', 'document', 'image']); // one attempt per item, nothing more
    expect((await jobRows()).length).toBe(before);                 // no retry queued
    expect((await T.admin.get('/agency/whatsapp')).body.connectionStatus).toBe('degraded');
    expect((await attemptsOf(q.id)).map((a) => a.attempts)).toEqual([1, 1, 1]);

    // even a stray queued job does nothing while the connection is unhealthy
    await jobs.enqueue(T.agencyId, 'quote.retry', { versionId: q.currentVersionId });
    await runDueJobs();
    expect(fake.attempted).toHaveLength(3);
    expect((await attemptsOf(q.id)).map((a) => a.attempts)).toEqual([1, 1, 1]);
    expect(await pendingJobs()).toHaveLength(0);

    // credentials restored -> staff retry -> every item delivered exactly once, no new delivery rows
    fake.sendError = undefined;
    expect((await refreshConnection()).body.connectionStatus).toBe('connected');
    const rec = await retry(q);
    expect(rec.body).toMatchObject({ versionStatus: 'sent', quoteStatus: 'sent', retryable: false, nextRetryMs: null });
    expect(fake.delivered.sort()).toEqual(['document', 'image', 'text']);
    const rows = await attemptsOf(q.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((a) => a.attempts)).toEqual([2, 2, 2]);
    expect(rows.every((a) => a.status === 'sent')).toBe(true);

    // a later worker tick must not resend anything
    await runDueJobs();
    expect(fake.delivered).toHaveLength(3);
    const msgs = await db.tenant(T.agencyId, (tx) => tx.message.findMany({ where: { direction: 'outbound', id: { in: rows.map((a) => a.messageId!).filter(Boolean) } } }));
    expect(msgs).toHaveLength(3);
    expect(msgs.every((m) => m.status === 'submitted' && m.providerMessageId)).toBe(true);
  });

  it('retryable failures are retried with growing delays up to the limit, then stop for good', async () => {
    const q = await newQuote(1);
    fake.sendError = rateLimitError();
    const first = await send(q);
    expect(first.body).toMatchObject({ versionStatus: 'failed', retryable: true, nextRetryMs: 60_000 });

    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      const pending = await pendingJobs();
      if (!pending.length) break;
      delays.push(pending[0].runAt.getTime() - pending[0].createdAt.getTime());
      await runDueJobs();
    }
    const rounded = delays.map((d) => Math.round(d / 1000) * 1000);
    expect(rounded).toEqual([60_000, 120_000, 240_000]);          // 1, 2, 4 minutes: three automatic retries
    expect(AUTO_RETRY_MAX_ATTEMPTS).toBe(4);
    const rows = await attemptsOf(q.id);
    expect(rows).toHaveLength(3);                                  // never new delivery rows
    expect(rows.map((a) => a.attempts)).toEqual([4, 4, 4]);        // 1 initial + 3 automatic retries
    expect(fake.attempted).toHaveLength(12);                       // 3 items x 4 attempts, no more
    expect(await pendingJobs()).toHaveLength(0);                   // chain ended

    // a stray queued job after exhaustion is ignored
    await jobs.enqueue(T.agencyId, 'quote.retry', { versionId: q.currentVersionId });
    await runDueJobs();
    expect(fake.attempted).toHaveLength(12);
    expect(await pendingJobs()).toHaveLength(0);

    // exhausted automatic retries do not block staff: a manual retry still works once the provider recovers
    fake.sendError = undefined;
    expect((await retry(q)).body.versionStatus).toBe('sent');
    expect(fake.delivered.sort()).toEqual(['document', 'image', 'text']);
    expect((await attemptsOf(q.id)).map((a) => a.attempts)).toEqual([5, 5, 5]);
  });

  it('a transient failure recovers on the automatic retry, with no further jobs and no duplicates', async () => {
    const q = await newQuote(1);
    fake.sendError = rateLimitError();
    await send(q);
    fake.sendError = undefined;                                    // provider recovers before the retry runs
    await runDueJobs();
    expect(fake.delivered.sort()).toEqual(['document', 'image', 'text']);
    expect(await pendingJobs()).toHaveLength(0);
    const rows = await attemptsOf(q.id);
    expect(rows.map((a) => a.attempts)).toEqual([2, 2, 2]);
    expect(rows.every((a) => a.status === 'sent')).toBe(true);
    expect((await T.admin.get(`/quotes/${q.id}`)).body.versions[0].status).toBe('sent');
  });

  it('only the failed item is retried: a photo that failed does not cause the text or PDF to be sent again', async () => {
    const q = await newQuote(1);
    // text and PDF succeed, then the image fails once (retryable)
    const realSendImage = fake.sendImage.bind(fake);
    let failImageOnce = true;
    fake.sendImage = async () => { if (failImageOnce) { failImageOnce = false; fake.attempted.push('image'); throw rateLimitError(); } return realSendImage(); };
    const r = await send(q);
    fake.sendImage = realSendImage;
    expect(r.body).toMatchObject({ versionStatus: 'partially_sent', retryable: true });
    expect(fake.delivered).toEqual(['text', 'document']);
    await runDueJobs();
    expect(fake.delivered.sort()).toEqual(['document', 'image', 'text']);   // each exactly once
    expect(fake.count('attempted', 'text')).toBe(1);
    expect(fake.count('attempted', 'document')).toBe(1);
    expect(fake.count('attempted', 'image')).toBe(2);
    expect(await attemptsOf(q.id)).toHaveLength(3);
  });

  it('pre-flight rejections (closed 24h window) are never retried automatically and never reach the provider', async () => {
    const q = await newQuote(0);
    await db.tenant(T.agencyId, (tx) => tx.conversation.update({ where: { id: convId }, data: { lastInboundAt: new Date(Date.now() - 25 * 3600 * 1000) } }));
    const r = await send(q);
    expect(r.body).toMatchObject({ versionStatus: 'failed', retryable: false, nextRetryMs: null });
    expect(fake.attempted).toHaveLength(0);
    expect(await pendingJobs()).toHaveLength(0);
    await db.tenant(T.agencyId, (tx) => tx.conversation.update({ where: { id: convId }, data: { lastInboundAt: new Date() } }));
  });

  it('an already-sent version is never touched by retries (immutability and no resend)', async () => {
    const q = await newQuote(1);
    expect((await send(q)).body.versionStatus).toBe('sent');
    const sentCount = fake.delivered.length;
    await jobs.enqueue(T.agencyId, 'quote.retry', { versionId: q.currentVersionId });
    await runDueJobs();
    expect((await retry(q)).body.versionStatus).toBe('sent');
    expect(fake.delivered).toHaveLength(sentCount);
    expect((await attemptsOf(q.id)).map((a) => a.attempts)).toEqual([1, 1, 1]);
  });
});
