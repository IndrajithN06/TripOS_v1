import request from 'supertest';
import { QuotesService } from '../src/modules/quotes/quotes.service';
import { bootCloud, CloudWorld, customerWrites } from './cloud-harness';
import { createVehicle, tripOutstation, uid } from './helpers';

/**
 * Deleting a quote while it is being sent. Isolated test database, fake WhatsApp provider: nothing reaches Meta.
 *
 * The choreography is deterministic (no sleeps to "hope" for an interleaving):
 *   - the QuotesService lock step is wrapped so a test can PAUSE one request right after it took the per-quote lock;
 *   - the competing request is then started and we wait until PostgreSQL reports it queued behind that lock (pg_locks);
 *   - only then is the first request released, so the order in which the two transactions run is exactly the one under test;
 *   - for "send wins" the provider call is held open, so the version is genuinely in 'sending' while the delete is decided.
 */
describe('Quote delete vs send: the race is closed', () => {
  let w: CloudWorld, vehicle: Awaited<ReturnType<typeof createVehicle>>;
  const admin = () => w.T.admin;
  const svc = () => w.app.get(QuotesService) as any;
  const phone = () => `+9196${Math.floor(10000000 + Math.random() * 89999999)}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fire = <T extends request.Test>(t: T) => t.then((r) => r); // supertest only sends once it is awaited/then-ed

  // ---- pause a request right after it took the quote lock
  let originalLock: (...a: any[]) => Promise<void>;
  let pending: { reached: () => void; release: Promise<void> } | null = null;
  const arm = () => {
    let reached!: () => void, release!: () => void;
    const hasLock = new Promise<void>((res) => (reached = res)), go = new Promise<void>((res) => (release = res));
    pending = { reached, release: go };
    return { hasLock, release };
  };
  const waiters = () => w.db.system((tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`).then((r) => r[0].n);
  const untilBlocked = async () => {
    for (let i = 0; i < 400; i++) { if ((await waiters()) > 0) return; await sleep(25); }
    throw new Error('the competing request never queued behind the quote lock');
  };

  // ---- hold the provider call open (so a version stays in "sending" while delete is decided)
  let origSend: Record<string, (...a: any[]) => Promise<any>> = {};
  const holdProvider = () => {
    let release!: () => void;
    const open = new Promise<void>((res) => (release = res));
    let entered!: () => void;
    const inProvider = new Promise<void>((res) => (entered = res));
    for (const k of ['sendText', 'sendTemplate', 'sendDocument', 'sendImage']) {
      const f = (w.fake as any)[k].bind(w.fake); origSend[k] = (w.fake as any)[k];
      (w.fake as any)[k] = async (...a: any[]) => { entered(); await open; return f(...a); };
    }
    return { release, inProvider };
  };

  const approvedTemplate = async () => {
    const spec = { purpose: 'quotation', header: { type: 'image', source: 'vehicle_photo' }, body: 'Hello {{customer_name}}, quotation {{quote_number}} is {{quote_total}}.', footer: 'Reply to book', buttons: [{ type: 'url', text: 'View', url: 'https://app.example.com/q/{{quote_token}}' }] };
    const t = (await admin().post('/agency/whatsapp/templates', { name: `race_${uid()}`, language: 'en', category: 'UTILITY', spec })).body;
    expect((await admin().post(`/agency/whatsapp/templates/${t.id}/submit`)).status).toBe(201);
    await request(w.app.getHttpServer()).post('/webhooks/whatsapp').send({ entry: [{ id: w.waba, time: Math.floor(Date.now() / 1000), changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: `meta-${t.name}`, message_template_name: t.name, message_template_language: 'en' } }] }] });
    return t;
  };
  const newQuote = async () => {
    const from = phone();
    await customerWrites(w, from);
    const convId = (await admin().get('/inbox/conversations?pageSize=100')).body.items.find((c: any) => c.customer?.phone === from).id as string;
    const r = await admin().post('/quotes', { conversationId: convId, vehicleTypeId: vehicle.id, trip: tripOutstation(), imageAssetIds: [vehicle.images[0].assetId] });
    expect(r.status).toBe(201);
    return r.body;
  };
  const rowOf = (id: string) => w.db.system((tx) => tx.quote.findUniqueOrThrow({ where: { id } }));
  const workOf = (quoteId: string) => w.db.system(async (tx) => {
    const versions = await tx.quoteVersion.findMany({ where: { quoteId } });
    const attempts = await tx.quoteSendAttempt.findMany({ where: { quoteVersionId: { in: versions.map((v) => v.id) } }, orderBy: { createdAt: 'asc' } });
    const audit = await tx.auditLog.findMany({ where: { entityType: 'quote', entityId: quoteId } });
    return { versions, attempts, audit };
  });

  beforeAll(async () => {
    w = await bootCloud('Race');
    vehicle = await createVehicle(admin(), 'RaceCar', 2);
    originalLock = svc().serialiseQuote.bind(svc());
    // The only change to the real service: after it has taken the lock, optionally wait for the test to say go.
    svc().serialiseQuote = async (...a: any[]) => { await originalLock(...a); const h = pending; if (h) { pending = null; h.reached(); await h.release; } };
  });
  afterAll(async () => { svc().serialiseQuote = originalLock; await w.app.close(); });
  beforeEach(() => { w.fake.sendError = undefined; w.fake.attempted.length = 0; w.fake.delivered.length = 0; w.fake.templateSends.length = 0; });
  afterEach(() => { pending = null; for (const [k, f] of Object.entries(origSend)) (w.fake as any)[k] = f; origSend = {}; });

  it('DELETE WINS over send(): the send is rejected (404) and creates NO send work', async () => {
    const q = await newQuote();
    const gate = arm();
    const del = fire(admin().del(`/quotes/${q.id}`).send({ reason: 'race' })); // takes the lock and pauses
    await gate.hasLock;
    const send = fire(admin().post(`/quotes/${q.id}/versions/1/send`));       // passes its checks only after the lock: must queue
    await untilBlocked();
    gate.release();                                                            // the delete commits first
    const [d, s] = await Promise.all([del, send]);

    expect(d.status).toBe(200);
    expect(s.status).toBe(404);
    expect(s.body.error.code).toBe('not_found');
    const work = await workOf(q.id);
    expect(work.attempts).toHaveLength(0);                        // no delivery rows were created
    expect(work.versions.map((v) => [v.status, v.pdfAssetId, v.sentAt])).toEqual([['draft', null, null]]); // never 'sending', no PDF stored
    expect(work.audit.map((a) => a.action)).not.toContain('quote.send_requested');
    expect(work.audit.filter((a) => a.action === 'quote.deleted')).toHaveLength(1);
    expect(w.fake.attempted).toHaveLength(0);                     // nothing reached the provider
    expect((await rowOf(q.id)).deletedAt).not.toBeNull();
  });

  it('DELETE WINS over sendWithTemplate(): rejected (404) before any template or send work', async () => {
    const q = await newQuote();
    const t = await approvedTemplate();
    const gate = arm();
    const del = fire(admin().del(`/quotes/${q.id}`));
    await gate.hasLock;
    const send = fire(admin().post(`/quotes/${q.id}/versions/1/send-template`, { templateId: t.id }));
    await untilBlocked();
    gate.release();
    const [d, s] = await Promise.all([del, send]);

    expect(d.status).toBe(200);
    expect(s.status).toBe(404);
    const work = await workOf(q.id);
    expect(work.attempts).toHaveLength(0);
    expect(work.versions.map((v) => [v.status, v.pdfAssetId, v.publicToken])).toEqual([['draft', null, null]]); // no PDF asset, no public link minted
    expect(work.audit.map((a) => a.action)).not.toContain('quote.template_send_requested');
    expect(w.fake.attempted).toHaveLength(0);
    expect(w.fake.templateSends).toHaveLength(0);
  });

  it('SEND WINS over delete: while it is sending, delete answers 409 and changes nothing; once finished, delete works', async () => {
    const q = await newQuote();
    const provider = holdProvider();
    const gate = arm();
    const send = fire(admin().post(`/quotes/${q.id}/versions/1/send`));       // takes the lock and pauses
    await gate.hasLock;
    const del = fire(admin().del(`/quotes/${q.id}`));                          // queues behind it
    await untilBlocked();
    gate.release();                                                            // planning commits 'sending'; execute stops at the held provider call
    await provider.inProvider;

    const d = await del;                                                       // decided while the send is genuinely in progress
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe('quote_sending');
    expect((await rowOf(q.id)).deletedAt).toBeNull();
    expect((await workOf(q.id)).versions[0].status).toBe('sending');
    expect((await workOf(q.id)).audit.map((a) => a.action)).not.toContain('quote.deleted');

    provider.release();                                                        // let the send finish
    const s = await send;
    expect(s.status).toBe(201);
    expect(s.body.versionStatus).toBe('sent');
    expect(w.fake.delivered.sort()).toEqual(['document', 'image', 'text']);    // the customer got exactly one copy

    expect((await admin().del(`/quotes/${q.id}`)).status).toBe(200);           // finished: now deletable, history intact
    const after = await workOf(q.id);
    expect(after.attempts).toHaveLength(3);
    expect(after.attempts.every((a) => a.status === 'sent')).toBe(true);
  });

  it('SEND WINS over delete for the template path too (409 while sending)', async () => {
    const q = await newQuote();
    const t = await approvedTemplate();
    const provider = holdProvider();
    const gate = arm();
    const send = fire(admin().post(`/quotes/${q.id}/versions/1/send-template`, { templateId: t.id }));
    await gate.hasLock;
    const del = fire(admin().del(`/quotes/${q.id}`));
    await untilBlocked();
    gate.release();
    await provider.inProvider;

    const d = await del;
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe('quote_sending');
    expect((await rowOf(q.id)).deletedAt).toBeNull();

    provider.release();
    const s = await send;
    expect(s.status).toBe(201);
    expect(s.body.versionStatus).toBe('sent');
    expect(w.fake.templateSends).toHaveLength(1);
    expect((await admin().del(`/quotes/${q.id}`)).status).toBe(200);
  });

  it('a delete that lands BETWEEN items (a retry or send holds no lock while it talks to WhatsApp) stops everything after the item in flight', async () => {
    const q = await newQuote();
    const realSendText = (w.fake as any).sendText.bind(w.fake);
    // After the first item (the text) is delivered, the quote is deleted by someone else; the PDF and photo must not follow.
    origSend.sendText = (w.fake as any).sendText;
    (w.fake as any).sendText = async (...a: any[]) => {
      const out = await realSendText(...a);
      await w.db.system((tx) => tx.quote.update({ where: { id: q.id }, data: { deletedAt: new Date(), deletedByUserId: w.T.adminId } }));
      return out;
    };
    const r = await admin().post(`/quotes/${q.id}/versions/1/send`);
    expect(r.status).toBe(201);
    expect(w.fake.attempted).toEqual(['text']);                                // nothing after the delete
    const work = await workOf(q.id);
    expect(work.attempts.map((a) => [a.kind, a.status])).toEqual([['text', 'sent'], ['pdf', 'pending'], ['image', 'pending']]);
    expect(work.versions[0].status).not.toBe('sending');                       // finalised: not left stuck in "sending"
    // and a later queued/explicit run is refused outright
    await expect(svc().execute(w.T.agencyId, work.versions[0].id, w.T.adminId)).rejects.toMatchObject({ response: { code: 'quote_deleted' } });
    expect(w.fake.attempted).toEqual(['text']);
  });

  it('no deadlocks: bursts of send, delete, edit and status changes on the same quote always finish with clean answers', async () => {
    for (let round = 0; round < 4; round++) {
      const q = await newQuote();
      const calls = await Promise.all([
        fire(admin().post(`/quotes/${q.id}/versions/1/send`)),
        fire(admin().del(`/quotes/${q.id}`)),
        fire(admin().patch(`/quotes/${q.id}/draft`, { notes: `n${round}` })),
        fire(admin().post(`/quotes/${q.id}/status`, { status: 'negotiating' })),
        fire(admin().del(`/quotes/${q.id}`)),
        fire(admin().post(`/quotes/${q.id}/versions/1/send`)),
      ]);
      for (const c of calls) expect(c.status).toBeLessThan(500); // never a 5xx: a deadlock victim or a lock failure would surface as a 500
      // invariant: whichever won, a deleted quote never gets work created after the delete
      const row = await rowOf(q.id);
      const work = await workOf(q.id);
      const deleteAudits = work.audit.filter((a) => a.action === 'quote.deleted');
      expect(deleteAudits.length).toBe(row.deletedAt ? 1 : 0);
      if (row.deletedAt) {
        const requested = work.audit.filter((a) => a.action === 'quote.send_requested');
        for (const a of requested) expect(a.createdAt.getTime()).toBeLessThanOrEqual(deleteAudits[0].createdAt.getTime());
        expect(work.versions[0].status).not.toBe('sending');
      }
    }
  });
});
