import { INestApplication } from '@nestjs/common';
import { Db } from '../src/db/db.service';
import { OutboundService } from '../src/modules/inbox/outbound.service';
import { SimulatorWhatsApp, WHATSAPP } from '../src/providers/whatsapp/whatsapp';
import { InboundService } from '../src/modules/webhooks/webhooks.module';
import { boot, Client, createVehicle, inboundMessage, onboard, superAdmin, Tenant, tripOutstation } from './helpers';

/**
 * Conversation workflow (NEW / ACTIVE / WAITING / RESOLVED) is derived from messages, with the existing open / pending / closed values stored.
 * Plus: the chat is reachable without any assignment step, assigned-only visibility and agency isolation are unchanged, and the
 * customer-details data (history counts, quote facts, follow-up overdue) is correct and private. Simulator provider, disposable test database.
 */
describe('Inbox workflow, assignment and customer details', () => {
  let app: INestApplication, sa: Client, A: Tenant, B: Tenant, db: Db, wa: SimulatorWhatsApp, vehicle: { id: string };
  const phone = () => `+9196${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const H = 3_600_000;

  async function chat(t: Tenant = A) {
    const from = phone();
    await inboundMessage(app, t, from, 'Hello, need a cab');
    return conversationOf(t, from);
  }
  async function conversationOf(t: Tenant, from: string) {
    const c = await db.system(async (tx) => {
      const cust = await tx.customer.findFirstOrThrow({ where: { agencyId: t.agencyId, phoneE164: from } });
      return tx.conversation.findFirstOrThrow({ where: { agencyId: t.agencyId, customerId: cust.id } });
    });
    return { id: c.id, from, customerId: c.customerId };
  }
  const row = (id: string) => db.system((tx) => tx.conversation.findUniqueOrThrow({ where: { id } }));
  const detail = async (who: Client, id: string) => (await who.get(`/inbox/conversations/${id}`)).body;
  const reply = (id: string, text = 'Happy to help', who: Client = A.sales) => who.post(`/inbox/conversations/${id}/messages`, { type: 'text', text });
  const inboundAgain = (t: Tenant, from: string, text = 'Any update?') => inboundMessage(app, t, from, text);
  const listIds = async (filter: string, who: Client = A.admin) => ((await who.get(`/inbox/conversations?filter=${filter}&pageSize=100`)).body.items as any[]).map((i) => i.id);
  const makeQuote = async (c: { id: string; customerId: string }, who: Client = A.sales) => {
    const r = await who.post('/quotes', { conversationId: c.id, customerId: c.customerId, vehicleTypeId: vehicle.id, trip: tripOutstation(), imageAssetIds: [] });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };

  beforeAll(async () => {
    app = await boot();
    db = app.get(Db);
    wa = app.get(WHATSAPP) as SimulatorWhatsApp;
    sa = await superAdmin(app);
    A = await onboard(app, sa, 'FlowA');
    B = await onboard(app, sa, 'FlowB');
    vehicle = await createVehicle(A.admin, 'FlowCar', 0);
  });
  afterAll(async () => { await app.close(); });

  describe('status follows the conversation', () => {
    it('the first customer message creates a NEW conversation (stored open, never answered)', async () => {
      const c = await chat();
      expect((await row(c.id)).status).toBe('open');
      const d = await detail(A.sales, c.id);
      expect(d.workflow).toBe('new');
      expect(d.unreadCount).toBeGreaterThan(0);
    });

    it('an employee\'s accepted reply moves it to WAITING', async () => {
      const c = await chat();
      expect((await reply(c.id)).body.ok).toBe(true);
      expect((await row(c.id)).status).toBe('pending');
      expect((await detail(A.sales, c.id)).workflow).toBe('waiting');
    });

    it('a FAILED send does not change the status', async () => {
      const c = await chat();
      wa.failNext.text = 1;
      const r = await reply(c.id, 'this will fail');
      expect(r.body.ok).toBe(false);
      expect((await row(c.id)).status).toBe('open');
      expect((await detail(A.sales, c.id)).workflow).toBe('new'); // a failed message is not an answer
    });

    it('a rejected send (window closed) changes nothing either', async () => {
      const c = await chat();
      await db.tenant(A.agencyId, (tx) => tx.conversation.update({ where: { id: c.id }, data: { lastInboundAt: new Date(Date.now() - 30 * H) } }));
      expect((await reply(c.id)).body.error.code).toBe('window_closed');
      expect((await row(c.id)).status).toBe('open');
    });

    it('a customer reply while WAITING returns it to the agency as ACTIVE (it was answered before)', async () => {
      const c = await chat();
      await reply(c.id);
      expect((await detail(A.sales, c.id)).workflow).toBe('waiting');
      await inboundAgain(A, c.from);
      expect((await row(c.id)).status).toBe('open');
      expect((await detail(A.sales, c.id)).workflow).toBe('active');
    });

    it('Resolve closes it, is repeatable, and a new customer message reopens it (ACTIVE if answered before)', async () => {
      const c = await chat();
      await reply(c.id);
      const r = await A.sales.post(`/inbox/conversations/${c.id}/resolve`);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: 'closed', workflow: 'resolved' });
      expect((await detail(A.sales, c.id)).workflow).toBe('resolved');
      expect((await A.sales.post(`/inbox/conversations/${c.id}/resolve`)).body.workflow).toBe('resolved'); // idempotent
      await inboundAgain(A, c.from, 'One more question');
      expect((await row(c.id)).status).toBe('open');
      expect((await detail(A.sales, c.id)).workflow).toBe('active');
    });

    it('a resolved chat the agency never answered reopens as NEW', async () => {
      const c = await chat();
      await A.sales.post(`/inbox/conversations/${c.id}/resolve`);
      await inboundAgain(A, c.from);
      expect((await detail(A.sales, c.id)).workflow).toBe('new');
    });

    it('resolving is audited, and does not touch quotes: quote status and conversation status are separate', async () => {
      const c = await chat();
      const quoteId = await makeQuote(c);
      await A.sales.post(`/inbox/conversations/${c.id}/resolve`);
      expect((await A.sales.get(`/quotes/${quoteId}`)).body.status).toBe('draft');
      const audit = await db.system((tx) => tx.auditLog.findFirst({ where: { agencyId: A.agencyId, action: 'conversation.resolved', entityId: c.id } }));
      expect(audit).toBeTruthy();
    });

    it('a message newer than the reply wins: if the customer wrote while the reply was being sent, the chat stays open', async () => {
      const c = await chat();
      // The customer's newest message is later than the reply message that is about to be created.
      await db.tenant(A.agencyId, (tx) => tx.conversation.update({ where: { id: c.id }, data: { lastInboundAt: new Date(Date.now() + 2 * H) } }));
      expect((await reply(c.id)).body.ok).toBe(true);
      expect((await row(c.id)).status).toBe('open');
    });

    it('a background job (no user) never counts as the agency answering', async () => {
      const c = await chat();
      const r = await app.get(OutboundService).send(A.agencyId, c.id, { kind: 'text', text: 'system retry' }, { userId: null });
      expect(r.ok).toBe(true);
      expect((await row(c.id)).status).toBe('open');
    });

    it('a message typed in the WhatsApp Business app (echo) moves it to WAITING, unless the customer wrote after it', async () => {
      const setCoexistence = (on: boolean) => db.system((tx) => tx.whatsappAccount.updateMany({ where: { agencyId: A.agencyId }, data: { isCoexistence: on } })); // echoes are accepted only for coexistence numbers
      await setCoexistence(true);
      try {
        const c = await chat();
        const now = Date.now();
        const echo = (id: string, at: number) => ({ kind: 'echo', phoneNumberId: A.phoneNumberId, providerMessageId: id, to: c.from, type: 'text', text: 'typed on the phone', timestamp: new Date(at) } as any);
        await app.get(InboundService).process([echo(`echo-${now}-a`, now + 5_000)]);
        expect((await row(c.id)).status).toBe('pending');
        // the customer answers, then an OLDER echo is delivered late: it must not flip the chat back to waiting
        await db.tenant(A.agencyId, (tx) => tx.conversation.update({ where: { id: c.id }, data: { status: 'open', lastInboundAt: new Date(now + 60_000) } }));
        await app.get(InboundService).process([echo(`echo-${now}-b`, now + 10_000)]);
        expect((await row(c.id)).status).toBe('open');
      } finally { await setCoexistence(false); }
    });

    it('older conversations keep working: stored pending / closed / open map to the right states', async () => {
      const waiting = await chat(), resolved = await chat(), answered = await chat();
      await db.tenant(A.agencyId, async (tx) => {
        await tx.conversation.update({ where: { id: waiting.id }, data: { status: 'pending' } });
        await tx.conversation.update({ where: { id: resolved.id }, data: { status: 'closed' } });
      });
      await reply(answered.id);
      await db.tenant(A.agencyId, (tx) => tx.conversation.update({ where: { id: answered.id }, data: { status: 'open' } })); // open, but answered earlier
      expect((await detail(A.admin, waiting.id)).workflow).toBe('waiting');
      expect((await detail(A.admin, resolved.id)).workflow).toBe('resolved');
      expect((await detail(A.admin, answered.id)).workflow).toBe('active');
    });
  });

  describe('list and filters', () => {
    it('every row carries its workflow state, and the New / Active / Waiting / Resolved filters pick the right chats', async () => {
      const fresh = await chat(), waiting = await chat(), active = await chat(), done = await chat();
      await reply(waiting.id);
      await reply(active.id); await inboundAgain(A, active.from);
      await A.sales.post(`/inbox/conversations/${done.id}/resolve`);
      const all = (await A.admin.get('/inbox/conversations?pageSize=100')).body;
      const wf = (id: string) => all.items.find((i: any) => i.id === id)?.workflow;
      expect([wf(fresh.id), wf(waiting.id), wf(active.id), wf(done.id)]).toEqual(['new', 'waiting', 'active', 'resolved']);
      expect(await listIds('new')).toEqual(expect.arrayContaining([fresh.id]));
      expect(await listIds('new')).not.toEqual(expect.arrayContaining([waiting.id, active.id, done.id]));
      expect(await listIds('active')).toContain(active.id);
      expect(await listIds('active')).not.toContain(fresh.id);
      expect(await listIds('waiting')).toContain(waiting.id);
      expect(await listIds('resolved')).toContain(done.id);
      expect(await listIds('resolved')).not.toContain(fresh.id);
    });

    it('the new filters respect agency isolation: another agency\'s chats never appear', async () => {
      const theirs = await chat(B);
      const mine = await chat(A);
      const ids = await listIds('new', A.admin);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
    });
  });

  describe('no assignment step, and visibility is unchanged', () => {
    it('with the default visibility every employee can open, answer and resolve an UNASSIGNED chat', async () => {
      const c = await chat();
      expect((await row(c.id)).assignedUserId).toBeNull();
      expect((await A.sales.get(`/inbox/conversations/${c.id}`)).status).toBe(200);
      expect((await reply(c.id, 'hi', A.sales)).body.ok).toBe(true);
      expect((await reply(c.id, 'hi again', A.admin)).body.ok).toBe(true);
      expect((await A.sales.post(`/inbox/conversations/${c.id}/resolve`)).status).toBe(201);
      expect((await A.sales.get('/inbox/conversations?pageSize=100')).body.items.map((i: any) => i.id)).toContain(c.id);
    });

    it('the response tells the UI which mode the agency is in, so assignment is shown only where it matters', async () => {
      const c = await chat();
      expect((await detail(A.sales, c.id)).salesVisibility).toBe('all');
      expect((await A.sales.get('/inbox/conversations')).body.salesVisibility).toBe('all');
    });

    it('assigned-only visibility is NOT bypassed: Sales see only chats assigned to them, and cannot resolve or answer others', async () => {
      const mine = await chat(), others = await chat();
      await A.admin.patch(`/inbox/conversations/${mine.id}`, { assignedUserId: A.salesId });
      const setVisibility = (v: string) => db.system((tx) => tx.agency.update({ where: { id: A.agencyId }, data: { salesVisibility: v } }));
      await setVisibility('assigned');
      try {
        expect((await detail(A.sales, mine.id)).salesVisibility).toBe('assigned');
        expect((await A.sales.get(`/inbox/conversations/${others.id}`)).status).toBe(404);
        expect((await A.sales.post(`/inbox/conversations/${others.id}/resolve`)).status).toBe(404);
        expect((await reply(others.id, 'nope', A.sales)).status).toBe(404);
        expect((await A.sales.get(`/inbox/conversations/${others.id}/starter-templates`)).status).toBe(404);
        const ids = (await A.sales.get('/inbox/conversations?pageSize=100')).body.items.map((i: any) => i.id);
        expect(ids).toContain(mine.id);
        expect(ids).not.toContain(others.id);
        expect((await A.sales.post(`/inbox/conversations/${mine.id}/resolve`)).status).toBe(201);
        // admins still see everything and can resolve anything
        expect((await A.admin.get(`/inbox/conversations/${others.id}`)).status).toBe(200);
        expect((await A.admin.post(`/inbox/conversations/${others.id}/resolve`)).status).toBe(201);
      } finally { await setVisibility('all'); }
    });

    it('assignment still works through the API for agencies that use assigned-only visibility, and stays inside the agency', async () => {
      const c = await chat();
      expect((await A.admin.patch(`/inbox/conversations/${c.id}`, { assignedUserId: A.salesId })).status).toBe(200);
      expect((await detail(A.admin, c.id)).assignedUser.id).toBe(A.salesId);
      expect((await A.admin.patch(`/inbox/conversations/${c.id}`, { assignedUserId: B.salesId })).status).toBe(400); // another agency's user
    });

    it('another agency cannot read, resolve or message a chat', async () => {
      const c = await chat(A);
      expect((await B.admin.get(`/inbox/conversations/${c.id}`)).status).toBe(404);
      expect((await B.admin.post(`/inbox/conversations/${c.id}/resolve`)).status).toBe(404);
      expect((await reply(c.id, 'x', B.admin)).status).toBe(404);
      expect((await row(c.id)).status).toBe('open'); // untouched
    });
  });

  describe('customer details data', () => {
    it('shows the customer, history counts, and since-date; counts stay inside the agency', async () => {
      const c = await chat();
      const q1 = await makeQuote(c), q2 = await makeQuote(c);
      await db.system((tx) => tx.quote.update({ where: { id: q2 }, data: { status: 'accepted' } }));
      const d = await detail(A.sales, c.id);
      expect(d.customer).toMatchObject({ id: c.customerId, phone: c.from });
      expect(d.customer.since).toBeTruthy();
      expect(d.customerHistory).toEqual({ otherConversations: 0, quotes: 2, acceptedQuotes: 1 });
      expect(d.quotes.map((q: any) => q.id)).toEqual(expect.arrayContaining([q1, q2]));
      // the same phone number in another agency is a different customer with its own, separate history
      await inboundMessage(app, B, c.from, 'hello B');
      const theirs = await conversationOf(B, c.from);
      expect((await detail(B.admin, theirs.id)).customerHistory).toEqual({ otherConversations: 0, quotes: 0, acceptedQuotes: 0 });
    });

    it('in assigned-only mode the history counts only what that employee may see', async () => {
      const c = await chat();
      await A.admin.patch(`/inbox/conversations/${c.id}`, { assignedUserId: A.salesId });
      await makeQuote(c, A.admin); // owned by the admin, but on a chat assigned to this salesperson
      const setVisibility = (v: string) => db.system((tx) => tx.agency.update({ where: { id: A.agencyId }, data: { salesVisibility: v } }));
      await setVisibility('assigned');
      try { expect((await detail(A.sales, c.id)).customerHistory.quotes).toBe(1); } finally { await setVisibility('all'); }
    });

    it('quotes carry the facts the panel shows: number, destination, total, dates, status', async () => {
      const c = await chat();
      const id = await makeQuote(c);
      const q = (await detail(A.sales, c.id)).quotes.find((x: any) => x.id === id);
      expect(q).toMatchObject({ id, status: 'draft', destination: 'Coorg', versionNumber: 1, tripType: 'outstation', followUpOverdue: false, followUpAt: null });
      expect(q.quoteNumber).toMatch(/^Q-/);
      expect(q.total).toMatch(/^\d+(\.\d+)?$/);
      expect(Number(q.total)).toBeGreaterThan(0);
      expect(q.createdAt).toBeTruthy();
    });

    it('follow-up overdue uses the dashboard rule: an open, unexpired quote whose follow-up date has passed', async () => {
      const c = await chat();
      const past = new Date(Date.now() - 2 * H), future = new Date(Date.now() + 5 * H);
      const sentOverdue = await makeQuote(c), sentLater = await makeQuote(c), draftPast = await makeQuote(c), expiredPast = await makeQuote(c);
      await db.system(async (tx) => {
        await tx.quote.update({ where: { id: sentOverdue }, data: { status: 'sent', followUpAt: past } });
        await tx.quote.update({ where: { id: sentLater }, data: { status: 'negotiating', followUpAt: future } });
        await tx.quote.update({ where: { id: draftPast }, data: { status: 'draft', followUpAt: past } });
        await tx.quote.update({ where: { id: expiredPast }, data: { status: 'sent', followUpAt: past, expiryAt: new Date(Date.now() - H) } });
      });
      const byId = (await detail(A.sales, c.id)).quotes.reduce((m: any, q: any) => ({ ...m, [q.id]: q }), {});
      expect(byId[sentOverdue]).toMatchObject({ status: 'sent', followUpOverdue: true });
      expect(byId[sentLater]).toMatchObject({ status: 'negotiating', followUpOverdue: false });
      expect(byId[draftPast]).toMatchObject({ status: 'draft', followUpOverdue: false });
      expect(byId[expiredPast]).toMatchObject({ status: 'expired', followUpOverdue: false });
    });

    it('the follow-up date can be set and cleared through the existing quote endpoint, and shows in the panel data', async () => {
      const c = await chat();
      const id = await makeQuote(c);
      const at = new Date(Date.now() + 24 * H).toISOString();
      expect((await A.sales.post(`/quotes/${id}/follow-up`, { followUpAt: at })).status).toBe(201);
      expect((await detail(A.sales, c.id)).quotes.find((q: any) => q.id === id).followUpAt).toBe(at);
      expect((await A.sales.post(`/quotes/${id}/follow-up`, { followUpAt: null })).status).toBe(201);
      expect((await detail(A.sales, c.id)).quotes.find((q: any) => q.id === id).followUpAt).toBeNull();
    });

    it('internal notes stay private: adding one sends nothing to WhatsApp and creates no customer-visible message', async () => {
      const c = await chat();
      const sentBefore = wa.sent.length;
      const msgsBefore = await db.system((tx) => tx.message.count({ where: { agencyId: A.agencyId, conversationId: c.id } }));
      expect((await A.sales.post(`/inbox/conversations/${c.id}/notes`, { text: 'prefers a morning pickup (internal)' })).status).toBe(201);
      expect(wa.sent.length).toBe(sentBefore);
      expect(await db.system((tx) => tx.message.count({ where: { agencyId: A.agencyId, conversationId: c.id } }))).toBe(msgsBefore);
      const d = await detail(A.sales, c.id);
      expect(d.notes).toHaveLength(1);
      expect(d.notes[0]).toMatchObject({ text: 'prefers a morning pickup (internal)', author: expect.any(String) });
      // and another agency can never see it
      expect((await B.admin.get(`/inbox/conversations/${c.id}`)).status).toBe(404);
    });

    it('the AI summary fields are gone from the conversation response', async () => {
      const c = await chat();
      const d = await detail(A.sales, c.id);
      expect(d).not.toHaveProperty('summary');
      expect(d).not.toHaveProperty('summaryAt');
    });
  });

  describe('the list can pin the opened chat to the top', () => {
    const ids = async (query: string, who: Client = A.admin) => ((await who.get(`/inbox/conversations?${query}`)).body.items as any[]).map((i) => i.id);

    it('an old chat that is not on the first page is shown first when focused, and never duplicated', async () => {
      const old = await chat();
      await db.tenant(A.agencyId, (tx) => tx.conversation.update({ where: { id: old.id }, data: { lastMessageAt: new Date(Date.now() - 400 * 24 * H) } }));
      await chat(); await chat(); await chat();
      expect(await ids('pageSize=3')).not.toContain(old.id); // too old for the first page
      const pinned = await ids(`pageSize=3&focus=${old.id}`);
      expect(pinned[0]).toBe(old.id);
      expect(pinned).toHaveLength(3);
      expect(pinned.filter((x) => x === old.id)).toHaveLength(1);
    });

    it('a chat already on the first page moves to the top, still once', async () => {
      const first = await chat(), second = await chat();
      const plain = await ids('pageSize=5');
      expect(plain.indexOf(second.id)).toBeLessThan(plain.indexOf(first.id)); // newest first
      const pinned = await ids(`pageSize=5&focus=${first.id}`);
      expect(pinned[0]).toBe(first.id);
      expect(pinned.filter((x) => x === first.id)).toHaveLength(1);
    });

    it('the pin is ignored with a filter, a search or a later page, so the list shows exactly what matches', async () => {
      const c = await chat();
      expect(await ids(`filter=resolved&focus=${c.id}`)).not.toContain(c.id); // it is not resolved
      expect(await ids(`search=zzz-no-match&focus=${c.id}`)).toEqual([]);
      expect((await ids(`page=2&pageSize=2&focus=${c.id}`))[0]).not.toBe(c.id);
    });

    it('it never shows a chat the person may not see: assigned-only Sales, and other agencies', async () => {
      const mine = await chat(), others = await chat();
      await A.admin.patch(`/inbox/conversations/${mine.id}`, { assignedUserId: A.salesId });
      const setVisibility = (v: string) => db.system((tx) => tx.agency.update({ where: { id: A.agencyId }, data: { salesVisibility: v } }));
      await setVisibility('assigned');
      try {
        expect(await ids(`pageSize=100&focus=${others.id}`, A.sales)).not.toContain(others.id);
        expect((await ids(`pageSize=100&focus=${mine.id}`, A.sales))[0]).toBe(mine.id);
      } finally { await setVisibility('all'); }
      expect(await ids(`pageSize=100&focus=${mine.id}`, B.admin)).not.toContain(mine.id);
    });

    it('a malformed focus is rejected', async () => {
      expect((await A.admin.get('/inbox/conversations?focus=not-an-id')).status).toBe(400);
    });
  });
});
