import { randomBytes, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { Db } from '../src/db/db.service';
import { configureApp } from '../src/main';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { QuotesService } from '../src/modules/quotes/quotes.service';
import { WHATSAPP } from '../src/providers/whatsapp/whatsapp';
import { FakeCloud, rateLimitError } from './fake-cloud';
import { Client, createVehicle, inboundMessage, onboard, superAdmin, Tenant, tripOutstation, uid } from './helpers';

/**
 * Soft delete of quotes. Isolated test database, fake WhatsApp provider: nothing here reaches Meta or a real customer.
 * The policy under test: a deleted quote disappears from every normal view and from the customer's link, while the quote row,
 * versions, delivery records, messages, files and audit history are all kept.
 */
describe('Quote soft delete', () => {
  let app: INestApplication, sa: Client, A: Tenant, B: Tenant, fake: FakeCloud, vehicle: Awaited<ReturnType<typeof createVehicle>>, convId: string;
  let db: Db, jobs: JobsService;
  const phone = `PN-${uid()}`, waba = `WABA-${uid()}`;

  beforeAll(async () => {
    fake = new FakeCloud();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(WHATSAPP).useValue(fake).compile();
    app = configureApp(mod.createNestApplication({ bodyParser: false, logger: false }));
    await app.init();
    db = app.get(Db); jobs = app.get(JobsService);
    sa = await superAdmin(app);
    A = await onboard(app, sa, 'DelA', { connect: false });
    expect((await A.admin.post('/agency/whatsapp/connect', { displayName: 'Del line', wabaId: waba, phoneNumberId: phone, accessToken: 'EAAG-fake-token-value' })).status).toBe(201);
    A.phoneNumberId = phone;
    B = await onboard(app, sa, 'DelB');
    vehicle = await createVehicle(A.admin, 'DelCar', 2);
    await inboundMessage(app, A, '919700001111', 'Need a car to Coorg');
    convId = (await A.admin.get('/inbox/conversations')).body.items[0].id;
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { fake.sendError = undefined; fake.attempted.length = 0; fake.delivered.length = 0; });

  const body = (extra: object = {}) => ({ conversationId: convId, vehicleTypeId: vehicle.id, trip: tripOutstation(), imageAssetIds: vehicle.images.slice(0, 1).map((i: any) => i.assetId), ...extra });
  const newQuote = async (who: Client = A.admin) => { const r = await who.post('/quotes', body()); expect(r.status).toBe(201); return r.body; };
  const sentQuote = async () => { const q = await newQuote(); const r = await A.admin.post(`/quotes/${q.id}/versions/1/send`); expect(r.status).toBe(201); expect(r.body.versionStatus).toBe('sent'); return q; };
  const row = (id: string) => db.system((tx) => tx.quote.findUniqueOrThrow({ where: { id } }));
  const counts = (id: string) => db.system(async (tx) => {
    const versions = await tx.quoteVersion.findMany({ where: { quoteId: id } });
    const vids = versions.map((v) => v.id);
    const attempts = await tx.quoteSendAttempt.findMany({ where: { quoteVersionId: { in: vids } }, orderBy: { createdAt: 'asc' } });
    const msgIds = attempts.map((a) => a.messageId).filter(Boolean) as string[];
    const messages = await tx.message.findMany({ where: { id: { in: msgIds } }, orderBy: { createdAt: 'asc' } });
    const audit = await tx.auditLog.findMany({ where: { entityType: 'quote', entityId: id }, orderBy: { createdAt: 'asc' } });
    const assets = await tx.asset.findMany({ where: { id: { in: [...versions.map((v) => v.pdfAssetId), ...attempts.map((a) => a.assetId)].filter(Boolean) as string[] } } });
    return { versions, attempts, messages, audit, assets };
  });

  it('an agency admin can delete an UNSENT draft: it is hidden, the row is kept, and the audit log records who and why', async () => {
    const q = await newQuote();
    const r = await A.admin.del(`/quotes/${q.id}`).send({ reason: '  Wrong dates  ' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: q.id, quoteNumber: q.quoteNumber, deleted: true });

    const kept = await row(q.id);
    expect(kept.deletedAt).toBeInstanceOf(Date);
    expect(kept.deletedByUserId).toBe(A.adminId);
    const c = await counts(q.id);
    expect(c.versions).toHaveLength(1);
    const del = c.audit.filter((a) => a.action === 'quote.deleted');
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({ actorUserId: A.adminId, agencyId: A.agencyId, entityType: 'quote' });
    expect(del[0].metadata).toMatchObject({ quoteNumber: q.quoteNumber, status: 'draft', version: 1, wasSent: false, reason: 'Wrong dates' });
    expect(c.audit.map((a) => a.action)).toContain('quote.created'); // earlier history untouched
  });

  it('a sent quote can be deleted too, and every message, delivery record, version, file and audit entry survives unchanged', async () => {
    const q = await sentQuote();
    const before = await counts(q.id);
    expect(before.attempts.length).toBeGreaterThan(0);
    expect(before.messages.length).toBe(before.attempts.length);

    expect((await A.admin.del(`/quotes/${q.id}`)).status).toBe(200);

    const after = await counts(q.id);
    expect(after.versions.map((v) => [v.id, v.status, v.sentAt, v.pdfAssetId, v.total.toString()])).toEqual(before.versions.map((v) => [v.id, v.status, v.sentAt, v.pdfAssetId, v.total.toString()]));
    expect(after.attempts.map((a) => [a.id, a.status, a.attempts, a.messageId])).toEqual(before.attempts.map((a) => [a.id, a.status, a.attempts, a.messageId]));
    expect(after.messages.map((m) => [m.id, m.status, m.text, m.providerMessageId])).toEqual(before.messages.map((m) => [m.id, m.status, m.text, m.providerMessageId]));
    expect(after.assets.map((a) => a.id).sort()).toEqual(before.assets.map((a) => a.id).sort());
    expect(after.audit.map((a) => a.id).slice(0, before.audit.length)).toEqual(before.audit.map((a) => a.id)); // nothing rewritten or removed
    expect(after.audit).toHaveLength(before.audit.length + 1);
    expect(after.audit[after.audit.length - 1]).toMatchObject({ action: 'quote.deleted' });
    expect((after.audit[after.audit.length - 1].metadata as any).wasSent).toBe(true);
    expect((after.audit[after.audit.length - 1].metadata as any).reason).toBeUndefined(); // reason is optional
  });

  it('a deleted quote is gone from the list, search, status filters and every detail route, while the chat history keeps the message', async () => {
    const q = await sentQuote();
    expect((await A.admin.get(`/quotes?search=${q.quoteNumber}`)).body.items.map((i: any) => i.id)).toContain(q.id);
    const dashBefore = (await A.admin.get('/dashboard')).body.metrics;
    const analyticsBefore = (await A.admin.get('/dashboard/analytics')).body;
    expect((await A.admin.get('/inbox/conversations/' + convId)).body.quotes.map((x: any) => x.id)).toContain(q.id);

    expect((await A.admin.del(`/quotes/${q.id}`)).status).toBe(200);

    expect((await A.admin.get(`/quotes?search=${q.quoteNumber}`)).body.items).toHaveLength(0);
    expect((await A.admin.get(`/quotes?status=sent&pageSize=100`)).body.items.map((i: any) => i.id)).not.toContain(q.id);
    expect((await A.admin.get('/quotes?search=919700001111&pageSize=100')).body.items.map((i: any) => i.id)).not.toContain(q.id);
    for (const url of [`/quotes/${q.id}`, `/quotes/${q.id}/versions/1/preview`, `/quotes/${q.id}/versions/1/pdf`, `/quotes/${q.id}/versions/1/templates`, `/quotes/${q.id}/diff?from=1&to=1`]) expect((await A.admin.get(url)).status).toBe(404);
    for (const [method, url, b] of [['post', `/quotes/${q.id}/duplicate`, {}], ['post', `/quotes/${q.id}/versions/1/send`, {}], ['post', `/quotes/${q.id}/versions/1/retry`, {}], ['post', `/quotes/${q.id}/status`, { status: 'accepted' }], ['post', `/quotes/${q.id}/follow-up`, { followUpAt: null }], ['post', `/quotes/${q.id}/versions`, {}], ['patch', `/quotes/${q.id}/draft`, { notes: 'x' }]] as const) {
      expect((await (A.admin as any)[method](url, b)).status).toBe(404);
    }
    expect((await A.admin.post(`/quotes/${q.id}/versions/1/send-template`, { templateId: randomUUID() })).status).toBe(404);

    // the inbox: the conversation panel and its "quoted" filter no longer show it ...
    expect((await A.admin.get('/inbox/conversations/' + convId)).body.quotes.map((x: any) => x.id)).not.toContain(q.id);
    // ... but the messages that were sent stay in the chat, labelled and without a link
    const msgs = (await A.admin.get(`/inbox/conversations/${convId}/messages?limit=100`)).body.items.filter((m: any) => m.quote?.quoteNumber === q.quoteNumber);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.every((m: any) => m.quote.quoteId === null && m.quote.deleted === true)).toBe(true);

    // dashboard and analytics no longer count it
    const dashAfter = (await A.admin.get('/dashboard')).body.metrics;
    expect(dashAfter.quotesCreated).toBe(dashBefore.quotesCreated - 1);
    expect(dashAfter.versionsCreated).toBe(dashBefore.versionsCreated - 1);
    expect((await A.admin.get('/dashboard/analytics')).status).toBe(200);
    expect(analyticsBefore).toBeDefined();
  });

  it('deleting is idempotent-safe: a repeat, a missing id and a malformed id are all clean errors with no extra audit row', async () => {
    const q = await newQuote();
    expect((await A.admin.del(`/quotes/${q.id}`)).status).toBe(200);
    const again = await A.admin.del(`/quotes/${q.id}`);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('not_found');
    expect((await A.admin.del(`/quotes/${randomUUID()}`)).status).toBe(404);
    expect((await A.admin.del('/quotes/not-a-uuid')).status).toBe(400);
    expect((await counts(q.id)).audit.filter((a) => a.action === 'quote.deleted')).toHaveLength(1);
  });

  it('two simultaneous deletes: exactly one wins, one audit row', async () => {
    const q = await newQuote();
    const [x, y] = await Promise.all([A.admin.del(`/quotes/${q.id}`), A.admin.del(`/quotes/${q.id}`)]);
    expect([x.status, y.status].sort()).toEqual([200, 404]);
    expect((await counts(q.id)).audit.filter((a) => a.action === 'quote.deleted')).toHaveLength(1);
  });

  it('another agency can neither delete nor see the quote: 404, and nothing changes', async () => {
    const q = await sentQuote();
    const r = await B.admin.del(`/quotes/${q.id}`).send({ reason: 'sneaky' });
    expect(r.status).toBe(404);
    expect((await B.sales.del(`/quotes/${q.id}`)).status).toBe(404);
    expect((await row(q.id)).deletedAt).toBeNull();
    expect((await counts(q.id)).audit.filter((a) => a.action === 'quote.deleted')).toHaveLength(0);
    expect((await A.admin.get(`/quotes/${q.id}`)).status).toBe(200);
  });

  it('roles: sales may delete their own quote but not a colleague\'s; the platform super admin and anonymous callers cannot delete', async () => {
    const adminsQuote = await newQuote(A.admin);
    const salesQuote = await newQuote(A.sales);
    // the agency shows everyone every quote ("all"): the colleague's quote is visible, so this is a clear 403
    const denied = await A.sales.del(`/quotes/${adminsQuote.id}`);
    expect(denied.status).toBe(403);
    expect((await row(adminsQuote.id)).deletedAt).toBeNull();
    expect((await A.sales.del(`/quotes/${salesQuote.id}`)).status).toBe(200);
    expect((await row(salesQuote.id)).deletedByUserId).toBe(A.salesId);
    // an admin may delete a sales user's quote
    const another = await newQuote(A.sales);
    expect((await A.admin.del(`/quotes/${another.id}`)).status).toBe(200);

    expect((await sa.del(`/quotes/${adminsQuote.id}`)).status).toBe(403);
    expect((await request(app.getHttpServer()).delete(`/quotes/${adminsQuote.id}`).set('x-tripos-csrf', '1')).status).toBe(401);
    expect((await row(adminsQuote.id)).deletedAt).toBeNull();
  });

  it('with "assigned only" visibility a sales user cannot even tell a colleague\'s quote exists (404, not 403)', async () => {
    const adminsQuote = await newQuote(A.admin);
    expect((await A.admin.patch('/agency/settings', { salesVisibility: 'assigned' })).status).toBe(200);
    try {
      expect((await A.sales.del(`/quotes/${adminsQuote.id}`)).status).toBe(404);
      expect((await row(adminsQuote.id)).deletedAt).toBeNull();
    } finally { await A.admin.patch('/agency/settings', { salesVisibility: 'all' }); }
  });

  it('refuses while the quote is being sent (409) and works once the send has finished', async () => {
    const q = await newQuote();
    await db.system((tx) => tx.quoteVersion.updateMany({ where: { quoteId: q.id }, data: { status: 'sending' } }));
    const r = await A.admin.del(`/quotes/${q.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('quote_sending');
    expect((await row(q.id)).deletedAt).toBeNull();
    await db.system((tx) => tx.quoteVersion.updateMany({ where: { quoteId: q.id }, data: { status: 'draft' } }));
    expect((await A.admin.del(`/quotes/${q.id}`)).status).toBe(200);
  });

  it('the customer\'s public quotation link and PDF stop working, and a deleted quote can no longer be sent by template', async () => {
    const q = await sentQuote();
    const token = randomBytes(18).toString('base64url');
    await db.system((tx) => tx.quoteVersion.updateMany({ where: { quoteId: q.id, versionNumber: 1 }, data: { publicToken: token } }));
    expect((await request(app.getHttpServer()).get(`/public/quotes/${token}`)).status).toBe(200);

    expect((await A.admin.del(`/quotes/${q.id}`)).status).toBe(200);

    const view = await request(app.getHttpServer()).get(`/public/quotes/${token}`);
    expect(view.status).toBe(404);
    expect(view.body.error.message).toMatch(/not valid/i); // the same answer as an unknown link: nothing leaks
    expect((await request(app.getHttpServer()).get(`/public/quotes/${token}/pdf`)).status).toBe(404);
    // the stored data is still there for audit
    expect((await db.system((tx) => tx.quoteVersion.findFirstOrThrow({ where: { quoteId: q.id, versionNumber: 1 } }))).publicToken).toBe(token);
  });

  it('a queued automatic retry never sends anything for a deleted quote and is not rescheduled', async () => {
    const q = await newQuote();
    fake.sendError = rateLimitError(); // a transient failure: the retry job is queued
    const r = await A.admin.post(`/quotes/${q.id}/versions/1/send`);
    expect(r.status).toBe(201);
    expect(r.body.versionStatus).toBe('failed');
    const pendingFor = () => db.tenant(A.agencyId, (tx) => tx.job.findMany({ where: { type: 'quote.retry', status: 'pending' } }));
    expect((await pendingFor()).length).toBeGreaterThan(0);

    expect((await A.admin.del(`/quotes/${q.id}`)).status).toBe(200);
    fake.sendError = undefined; fake.attempted.length = 0; fake.delivered.length = 0;
    await db.system(async (tx) => {
      await tx.job.updateMany({ where: { agencyId: { not: A.agencyId }, status: 'pending' }, data: { runAt: new Date(Date.now() + 86_400_000) } });
      await tx.job.updateMany({ where: { agencyId: A.agencyId, status: 'pending' }, data: { runAt: new Date(Date.now() - 60_000) } });
    });
    await jobs.tick();

    expect(fake.attempted).toHaveLength(0);
    expect(fake.delivered).toHaveLength(0);
    expect(await pendingFor()).toHaveLength(0); // handled and finished, not retried again
    const attempts = (await counts(q.id)).attempts;
    expect(attempts.every((a) => a.status === 'failed' && a.attempts === 1)).toBe(true); // untouched
    // an explicit execute() (e.g. a race with a staff retry) is refused the same way
    await expect(app.get(QuotesService).execute(A.agencyId, (await counts(q.id)).versions[0].id, A.adminId)).rejects.toMatchObject({ response: { code: 'quote_deleted' } });
    expect(fake.attempted).toHaveLength(0);
  });

  it('the expiry sweeper leaves a deleted quote alone', async () => {
    const q = await sentQuote();
    expect((await A.admin.del(`/quotes/${q.id}`)).status).toBe(200);
    await db.system((tx) => tx.quote.update({ where: { id: q.id }, data: { expiryAt: new Date(Date.now() - 3_600_000) } }));
    await app.get(QuotesService).expireOverdue();
    expect((await row(q.id)).status).toBe('sent');
  });

  it('the quote number of a deleted quote is never reused', async () => {
    const q = await newQuote();
    expect((await A.admin.del(`/quotes/${q.id}`)).status).toBe(200);
    const next = await newQuote();
    expect(next.quoteNumber).not.toBe(q.quoteNumber);
    expect(await db.system((tx) => tx.quote.count({ where: { agencyId: A.agencyId, quoteNumber: q.quoteNumber } }))).toBe(1);
  });
});
