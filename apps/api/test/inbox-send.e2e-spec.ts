import { INestApplication } from '@nestjs/common';
import { Db } from '../src/db/db.service';
import { SimulatorWhatsApp, WHATSAPP } from '../src/providers/whatsapp/whatsapp';
import { boot, Client, createVehicle, inboundMessage, onboard, superAdmin, Tenant, tripOutstation, uid } from './helpers';

/**
 * WhatsApp sending rules, against the simulator provider and the disposable test database (nothing reaches Meta):
 * free-form text only inside the 24-hour customer-service window, template-only outside it, per-agency isolation, the five built-in
 * starters (which are never Meta templates), and what happens when a send fails.
 */
describe('Inbox sending: service window, templates and built-in starters', () => {
  let app: INestApplication, sa: Client, A: Tenant, B: Tenant, db: Db, wa: SimulatorWhatsApp;
  const H = 3_600_000;
  const phone = () => `+9197${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const NOTICE = /may charge/i;

  /** A customer who has just messaged this agency: returns their conversation id and phone. */
  async function customer(t: Tenant) {
    const from = phone();
    await inboundMessage(app, t, from, 'Hello, need a cab');
    const conv = await db.system(async (tx) => {
      const c = await tx.customer.findFirstOrThrow({ where: { agencyId: t.agencyId, phoneE164: from } });
      return tx.conversation.findFirstOrThrow({ where: { agencyId: t.agencyId, customerId: c.id } });
    });
    return { id: conv.id, from };
  }
  const setInbound = (t: Tenant, id: string, at: Date | null) => db.tenant(t.agencyId, (tx) => tx.conversation.update({ where: { id }, data: { lastInboundAt: at } }));
  const sendText = (t: Tenant, id: string, text = 'hello', extra: object = {}) => t.sales.post(`/inbox/conversations/${id}/messages`, { type: 'text', text, ...extra });
  const messageCount = (t: Tenant, id: string) => db.system((tx) => tx.message.count({ where: { agencyId: t.agencyId, conversationId: id, direction: 'outbound' } }));
  const detail = async (t: Tenant, id: string) => (await t.sales.get(`/inbox/conversations/${id}`)).body;

  /** A positional template (one variable) in the given provider state. */
  async function template(t: Tenant, status: 'approved' | 'rejected' | 'paused' | 'pending' | 'draft' | 'submitted', language = 'en') {
    const r = await t.admin.post('/agency/whatsapp/templates', { name: `tpl_${uid()}`, language, body: 'Hi {{1}}, your quotation is ready', variableSchema: ['name'] });
    expect(r.status).toBe(201);
    if (status !== 'draft') await t.admin.post(`/agency/whatsapp/templates/${r.body.id}/submit`);
    if (['approved', 'rejected', 'paused', 'pending'].includes(status)) await t.admin.post('/dev/simulator/template-decision', { templateId: r.body.id, status });
    return r.body as { id: string; name: string; language: string };
  }
  const sendTemplate = (t: Tenant, id: string, templateId: string, variables: string[]) => t.sales.post(`/inbox/conversations/${id}/messages`, { type: 'template', templateId, variables });

  beforeAll(async () => {
    app = await boot();
    db = app.get(Db);
    wa = app.get(WHATSAPP) as SimulatorWhatsApp;
    sa = await superAdmin(app);
    A = await onboard(app, sa, 'WinA');
    B = await onboard(app, sa, 'WinB');
  });
  afterAll(async () => { await app.close(); });

  describe('free-form text and the 24-hour window', () => {
    it('is accepted while the window is open, and the conversation reports it open', async () => {
      const c = await customer(A);
      const r = await sendText(A, c.id, 'Hi, how can I help?');
      expect(r.status).toBe(201);
      expect(r.body.ok).toBe(true);
      const d = await detail(A, c.id);
      expect(d.windowOpen).toBe(true);
      expect(d.sendBlock).toBeNull();
    });

    it('is refused on the server outside the window, with an explanation, and nothing is recorded or sent', async () => {
      const c = await customer(A);
      await setInbound(A, c.id, new Date(Date.now() - 25 * H));
      const before = { sent: wa.sent.length, rows: await messageCount(A, c.id) };
      const r = await sendText(A, c.id, 'late');
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('window_closed');
      expect(r.body.error.message).toMatch(/approved template/i);
      expect(wa.sent.length).toBe(before.sent);
      expect(await messageCount(A, c.id)).toBe(before.rows);
      const d = await detail(A, c.id);
      expect(d.windowOpen).toBe(false);
      expect(d.sendBlock.code).toBe('window_closed');
    });

    it('expiry boundary: 23h59m is open, 24h01m is closed (checked at the server)', async () => {
      const c = await customer(A);
      await setInbound(A, c.id, new Date(Date.now() - (24 * H - 60_000)));
      expect((await sendText(A, c.id, 'inside')).body.ok).toBe(true);
      await setInbound(A, c.id, new Date(Date.now() - (24 * H + 60_000)));
      expect((await sendText(A, c.id, 'outside')).body.error.code).toBe('window_closed');
    });

    it('a customer who has never messaged cannot be sent free-form text', async () => {
      const c = await customer(A);
      await setInbound(A, c.id, null);
      const r = await sendText(A, c.id);
      expect(r.body.error.code).toBe('window_closed');
      expect(r.body.error.message).toMatch(/has not messaged you yet/i);
    });

    it('a new inbound message re-opens an expired window', async () => {
      const c = await customer(A);
      await setInbound(A, c.id, new Date(Date.now() - 30 * H));
      expect((await sendText(A, c.id)).body.error.code).toBe('window_closed');
      await inboundMessage(app, A, c.from, 'Are you there?');
      expect((await detail(A, c.id)).windowOpen).toBe(true);
      expect((await sendText(A, c.id, 'Yes!')).body.ok).toBe(true);
    });

    it('an outbound message does not extend the window; only the customer does', async () => {
      const c = await customer(A);
      const old = new Date(Date.now() - 23 * H);
      await setInbound(A, c.id, old);
      expect((await sendText(A, c.id, 'reply')).body.ok).toBe(true);
      const after = await db.system((tx) => tx.conversation.findUniqueOrThrow({ where: { id: c.id } }));
      expect(after.lastInboundAt?.getTime()).toBe(old.getTime());
    });
  });

  describe('different agencies and phone numbers', () => {
    it('each agency has its own conversation and window, and cannot read or send into the other', async () => {
      const shared = phone();
      await inboundMessage(app, A, shared, 'to A');
      await inboundMessage(app, B, shared, 'to B');
      const find = (t: Tenant) => db.system(async (tx) => {
        const cust = await tx.customer.findFirstOrThrow({ where: { agencyId: t.agencyId, phoneE164: shared } });
        return tx.conversation.findFirstOrThrow({ where: { agencyId: t.agencyId, customerId: cust.id } });
      });
      const ca = await find(A), cb = await find(B);
      expect(ca.id).not.toBe(cb.id);
      expect(A.phoneNumberId).not.toBe(B.phoneNumberId);

      await setInbound(A, ca.id, new Date(Date.now() - 30 * H)); // A's window closes...
      expect((await sendText(A, ca.id)).body.error.code).toBe('window_closed');
      expect((await sendText(B, cb.id)).body.ok).toBe(true); // ...B's is untouched

      expect((await sendText(B, ca.id)).status).toBe(404);
      expect((await B.sales.get(`/inbox/conversations/${ca.id}`)).status).toBe(404);
      expect((await B.sales.get(`/inbox/conversations/${ca.id}/starter-templates`)).status).toBe(404);
    });

    it("a message to one agency's number never opens a window in another agency's chat", async () => {
      const c = await customer(A);
      await setInbound(A, c.id, new Date(Date.now() - 30 * H));
      await inboundMessage(app, B, c.from, 'writing to B, not A');
      expect((await detail(A, c.id)).windowOpen).toBe(false);
    });
  });

  describe('a disconnected account', () => {
    it('refuses text with a clear reason (before the window is even considered) and reports it on the conversation', async () => {
      const c = await customer(A);
      const original = await db.system((tx) => tx.whatsappAccount.findFirstOrThrow({ where: { agencyId: A.agencyId } }));
      await db.tenant(A.agencyId, (tx) => tx.whatsappAccount.update({ where: { id: original.id }, data: { connectionStatus: 'disconnected', statusReason: 'Access was revoked in Meta Business settings' } }));
      try {
        const r = await sendText(A, c.id);
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe('whatsapp_not_connected');
        expect(r.body.error.message).toContain('Access was revoked in Meta Business settings');
        const d = await detail(A, c.id);
        expect(d.windowOpen).toBe(true); // the window itself is fine; the connection is the problem
        expect(d.sendBlock.code).toBe('whatsapp_not_connected');
        // Templates cannot be sent either.
        const t = await template(A, 'approved');
        expect((await sendTemplate(A, c.id, t.id, ['Asha'])).body.error.code).toBe('whatsapp_not_connected');
      } finally {
        await db.tenant(A.agencyId, (tx) => tx.whatsappAccount.update({ where: { id: original.id }, data: { connectionStatus: original.connectionStatus, statusReason: original.statusReason } }));
      }
      expect((await sendText(A, c.id)).body.ok).toBe(true);
    });
  });

  describe('Meta templates (the only thing allowed outside the window)', () => {
    it('an approved template is sent outside the window with its own name, language and parameters', async () => {
      const c = await customer(A);
      await setInbound(A, c.id, new Date(Date.now() - 40 * H));
      const t = await template(A, 'approved', 'en_GB');
      const spy = jest.spyOn(wa, 'sendTemplate');
      try {
        const r = await sendTemplate(A, c.id, t.id, ['Asha']);
        expect(r.body.ok).toBe(true);
        const [acct, to, payload] = spy.mock.calls[0] as any[];
        expect(acct.phoneNumberId).toBe(A.phoneNumberId);
        expect(to).toBe(c.from);
        expect(payload).toMatchObject({ name: t.name, language: 'en_GB', variables: ['Asha'] });
      } finally { spy.mockRestore(); }
    });

    it.each(['rejected', 'paused', 'pending', 'submitted', 'draft'] as const)('a %s template is refused and nothing is sent', async (status) => {
      const c = await customer(A);
      const t = await template(A, status);
      const before = { sent: wa.sent.length, rows: await messageCount(A, c.id) };
      const r = await sendTemplate(A, c.id, t.id, ['Asha']);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('template_not_approved');
      expect(wa.sent.length).toBe(before.sent);
      expect(await messageCount(A, c.id)).toBe(before.rows);
    });

    it('an unknown template, or another agency\'s template, is not found', async () => {
      const c = await customer(A);
      const theirs = await template(B, 'approved');
      expect((await sendTemplate(A, c.id, theirs.id, ['Asha'])).status).toBe(404);
      expect((await sendTemplate(A, c.id, '00000000-0000-4000-8000-000000000000', ['Asha'])).status).toBe(404);
    });

    it('wrong parameter counts and blank parameters are refused before anything is sent', async () => {
      const c = await customer(A);
      const t = await template(A, 'approved');
      const before = wa.sent.length;
      for (const vars of [[], ['a', 'b'], ['   ']]) {
        const r = await sendTemplate(A, c.id, t.id, vars);
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe('template_variables');
      }
      expect(wa.sent.length).toBe(before);
    });

    it('when the window is closed and the template cannot be sent, no free-text fallback is ever sent', async () => {
      const c = await customer(A);
      await setInbound(A, c.id, new Date(Date.now() - 40 * H));
      const t = await template(A, 'rejected');
      const before = { sent: wa.sent.length, rows: await messageCount(A, c.id) };
      expect((await sendTemplate(A, c.id, t.id, ['Asha'])).body.error.code).toBe('template_not_approved');
      expect(wa.sent.length).toBe(before.sent);
      expect(await messageCount(A, c.id)).toBe(before.rows);
    });
  });

  describe('failures, retries, duplicates and delivery status', () => {
    const providerIdOf = (t: Tenant, messageId: string) => db.system((tx) => tx.message.findUniqueOrThrow({ where: { id: messageId } })).then((m) => m.providerMessageId!);

    it('a provider failure is recorded with its reason and can be retried while the window is open', async () => {
      const c = await customer(A);
      wa.failNext.text = 1;
      const f = await sendText(A, c.id, 'will fail');
      expect(f.body.ok).toBe(false);
      expect(f.body.status).toBe('failed');
      expect(f.body.errorCode).toBe('sim_failure');
      const row = await db.system((tx) => tx.message.findUniqueOrThrow({ where: { id: f.body.messageId } }));
      expect(row.status).toBe('failed');
      expect(row.errorMessage).toMatch(/delivery failure/);
      const retry = await A.sales.post(`/inbox/conversations/${c.id}/messages/${f.body.messageId}/retry`);
      expect(retry.body.ok).toBe(true);
    });

    it('a failed message cannot be retried once the window has closed (no way around the rule)', async () => {
      const c = await customer(A);
      wa.failNext.text = 1;
      const f = await sendText(A, c.id, 'will fail');
      await setInbound(A, c.id, new Date(Date.now() - 30 * H));
      const before = wa.sent.length;
      const retry = await A.sales.post(`/inbox/conversations/${c.id}/messages/${f.body.messageId}/retry`);
      expect(retry.body.error.code).toBe('window_closed');
      expect(wa.sent.length).toBe(before);
    });

    it('the same idempotency key never sends twice', async () => {
      const c = await customer(A);
      const key = `k-${uid()}`;
      const first = await sendText(A, c.id, 'once', { idempotencyKey: key });
      const before = wa.sent.length;
      const second = await sendText(A, c.id, 'once', { idempotencyKey: key });
      expect(second.body.deduplicated).toBe(true);
      expect(second.body.messageId).toBe(first.body.messageId);
      expect(wa.sent.length).toBe(before);
    });

    it('delivery status moves forward (submitted -> delivered -> read) and a later failure webhook records its reason', async () => {
      const c = await customer(A);
      const sent = await sendText(A, c.id, 'track me');
      const pid = await providerIdOf(A, sent.body.messageId);
      await A.sales.post('/dev/simulator/status', { providerMessageId: pid, status: 'delivered' });
      expect((await db.system((tx) => tx.message.findUniqueOrThrow({ where: { id: sent.body.messageId } }))).status).toBe('delivered');
      await A.sales.post('/dev/simulator/status', { providerMessageId: pid, status: 'read' });
      await A.sales.post('/dev/simulator/status', { providerMessageId: pid, status: 'delivered' });
      expect((await db.system((tx) => tx.message.findUniqueOrThrow({ where: { id: sent.body.messageId } }))).status).toBe('read');

      const other = await sendText(A, c.id, 'this one fails later');
      const pid2 = await providerIdOf(A, other.body.messageId);
      await A.sales.post('/dev/simulator/status', { providerMessageId: pid2, status: 'failed', errorMessage: 'Recipient not on WhatsApp' });
      const failed = await db.system((tx) => tx.message.findUniqueOrThrow({ where: { id: other.body.messageId } }));
      expect(failed.status).toBe('failed');
      expect(failed.errorMessage).toBe('Recipient not on WhatsApp');
    });
  });

  describe('built-in TripOS starters (not Meta templates)', () => {
    let vehicle: { id: string };
    beforeAll(async () => { vehicle = await createVehicle(A.admin, 'StarterCar', 0); });

    it('lists exactly the five starters with their fields, the window state and a neutral charges notice', async () => {
      const c = await customer(A);
      const r = await A.sales.get(`/inbox/conversations/${c.id}/starter-templates`);
      expect(r.status).toBe(200);
      expect(r.body.items.map((i: any) => i.label)).toEqual(['Quotation Ready', 'Quote Follow-up', 'Booking Confirmation', 'Payment Reminder', 'Upcoming Trip Reminder']);
      expect(r.body.windowOpen).toBe(true);
      expect(r.body.sendBlock).toBeNull();
      expect(r.body.notice).toMatch(NOTICE);
      expect(r.body.notice).not.toMatch(/₹|\d/); // no amounts, no promises
      const pay = r.body.items.find((i: any) => i.key === 'payment_reminder');
      expect(pay.fields.find((f: any) => f.name === 'amount_due').auto).toBe(false);
      expect(pay.fields.find((f: any) => f.name === 'customer_name').auto).toBe(true);
    });

    it('fills customer and agency details automatically and asks for what V1 cannot know', async () => {
      const c = await customer(A);
      const r = await A.sales.post(`/inbox/conversations/${c.id}/starter-templates/payment_reminder/render`, {});
      expect(r.status).toBe(201);
      expect(r.body.text).toContain('Test Customer');
      expect(r.body.missing.sort()).toEqual(['amount_due', 'booking_reference']);
      expect(r.body.text).toContain('{{amount_due}}');
      expect(r.body.fields.find((f: any) => f.name === 'amount_due').auto).toBe(false);
    });

    it("draws the quotation's number, destination, dates, duration and amount from the conversation's latest quote", async () => {
      const c = await customer(A);
      const custId = (await db.system((tx) => tx.conversation.findUniqueOrThrow({ where: { id: c.id } }))).customerId;
      const q = await A.sales.post('/quotes', { conversationId: c.id, customerId: custId, vehicleTypeId: vehicle.id, trip: tripOutstation(), imageAssetIds: [] });
      expect(q.status).toBe(201);
      const r = await A.sales.post(`/inbox/conversations/${c.id}/starter-templates/quotation_ready/render`, {});
      expect(r.body.missing).toEqual([]);
      expect(r.body.text).toContain('Q-');
      expect(r.body.text).toContain('Coorg');
      expect(r.body.text).toContain('3 days');
      expect(r.body.text).toContain('20,400.00');
    });

    it('the agent\'s own values win, are sanitised, and cannot inject other placeholders', async () => {
      const c = await customer(A);
      const r = await A.sales.post(`/inbox/conversations/${c.id}/starter-templates/booking_confirmation/render`, {
        values: { booking_reference: 'BK-9', departure_date: '20 Dec 2030', destination: 'Hampi {{agency_name}}', unrelated: 'ignored' },
      });
      expect(r.body.text).toContain('BK-9');
      expect(r.body.text).toContain('20 Dec 2030');
      expect(r.body.text).toContain('Hampi agency_name');
      expect(r.body.fields.find((f: any) => f.name === 'destination').auto).toBe(false);
      expect(r.body.missing).toEqual(['pickup_location']); // no quote on this conversation, so no pickup location: asked for, not guessed
    });

    it('reports a closed window or a disconnected account on the starters too, so the UI can steer to Meta templates', async () => {
      const c = await customer(A);
      await setInbound(A, c.id, new Date(Date.now() - 30 * H));
      const r = await A.sales.post(`/inbox/conversations/${c.id}/starter-templates/quote_followup/render`, {});
      expect(r.body.windowOpen).toBe(false);
      expect(r.body.sendBlock.code).toBe('window_closed');
      // A starter has no send endpoint of its own: sending still goes through the guarded text path, which refuses.
      expect((await sendText(A, c.id, r.body.text)).body.error.code).toBe('window_closed');
    });

    it('rendering sends and records nothing', async () => {
      const c = await customer(A);
      const before = { sent: wa.sent.length, rows: await messageCount(A, c.id) };
      await A.sales.post(`/inbox/conversations/${c.id}/starter-templates/quotation_ready/render`, {});
      await A.sales.get(`/inbox/conversations/${c.id}/starter-templates`);
      expect(wa.sent.length).toBe(before.sent);
      expect(await messageCount(A, c.id)).toBe(before.rows);
    });

    it('an unknown starter is not found, and a starter never appears among Meta templates', async () => {
      const c = await customer(A);
      expect((await A.sales.post(`/inbox/conversations/${c.id}/starter-templates/nope/render`, {})).status).toBe(404);
      const metaTemplates = (await A.admin.get('/agency/whatsapp/templates')).body as any[];
      for (const key of ['quotation_ready', 'quote_followup', 'booking_confirmation', 'payment_reminder', 'upcoming_trip_reminder']) expect(metaTemplates.find((t) => t.name === key)).toBeUndefined();
    });

    it('sales who may only see assigned chats cannot render starters for a chat they cannot see', async () => {
      const c = await customer(A);
      const setVisibility = (v: string) => db.system((tx) => tx.agency.update({ where: { id: A.agencyId }, data: { salesVisibility: v } }));
      await setVisibility('assigned');
      try {
        expect((await A.sales.get(`/inbox/conversations/${c.id}`)).status).toBe(404);
        expect((await A.sales.get(`/inbox/conversations/${c.id}/starter-templates`)).status).toBe(404);
        expect((await A.sales.post(`/inbox/conversations/${c.id}/starter-templates/quote_followup/render`, {})).status).toBe(404);
        expect((await A.admin.get(`/inbox/conversations/${c.id}/starter-templates`)).status).toBe(200);
      } finally { await setVisibility('all'); }
    });
  });
});
