import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { decryptSecret } from '../src/common/crypto';
import { resetConfigForTests } from '../src/config/config';
import { Db } from '../src/db/db.service';
import { configureApp } from '../src/main';
import { WHATSAPP } from '../src/providers/whatsapp/whatsapp';
import { FakeCloud } from './fake-cloud';
import { Client, onboard, superAdmin, Tenant, uid } from './helpers';

// WhatsApp Business app coexistence webhooks (message echoes, history, contacts, PARTNER_REMOVED) against a FAKE Meta.
const FLAG = ['WHATSAPP_EMBEDDED_SIGNUP_ENABLED', 'WHATSAPP_APP_ID', 'WHATSAPP_SIGNUP_APP_ID', 'WHATSAPP_SIGNUP_APP_SECRET', 'WHATSAPP_SIGNUP_VERIFY_TOKEN', 'WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID'] as const;
const saved: Record<string, string | undefined> = {};

describe('Coexistence webhooks, fake Meta', () => {
  let app: INestApplication, sa: Client, fake: FakeCloud, db: Db;
  let C: Tenant & { waba: string; phone: string }; // onboarded through Embedded Signup (coexistence)
  let M: Tenant & { waba: string; phone: string }; // connected manually
  let C2: Tenant & { waba: string; phone: string }; // a second coexistence agency, for isolation

  // Embedded Signup accounts belong to the signup Meta app: their webhooks are delivered to (and authenticated by) /webhooks/whatsapp/signup.
  // Manual accounts belong to the primary app: /webhooks/whatsapp. (The fake provider here does not check signatures; see two-app-webhooks.)
  const signupIds = new Set<string>();
  const routeFor = (body: any) => {
    const entry = body?.entry?.[0], v = entry?.changes?.[0]?.value;
    return [entry?.id, v?.waba_info?.waba_id, v?.metadata?.phone_number_id].some((x) => x && signupIds.has(x)) ? '/webhooks/whatsapp/signup' : '/webhooks/whatsapp';
  };
  const hook = (body: object) => request(app.getHttpServer()).post(routeFor(body)).send(body);
  const wrap = (phone: string, waba: string, field: string, value: object, extra: object = {}) =>
    ({ object: 'whatsapp_business_account', entry: [{ id: waba, time: Math.floor(Date.now() / 1000), changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '919800000000', phone_number_id: phone }, ...value } }], ...extra }] });
  const echo = (t: { phone: string; waba: string }, to: string, id = `wamid.E-${uid()}`, over: object = {}) =>
    wrap(t.phone, t.waba, 'smb_message_echoes', { message_echoes: [{ from: '919800000000', to: to.slice(1), id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Sent from the app' }, ...over }] });
  const msgs = (agencyId: string) => db.tenant(agencyId, (tx) => tx.message.findMany({ where: { agencyId }, orderBy: { createdAt: 'asc' } }));
  const acct = (agencyId: string) => db.tenant(agencyId, (tx) => tx.whatsappAccount.findFirstOrThrow({ where: { agencyId } }));
  const customers = (agencyId: string) => db.tenant(agencyId, (tx) => tx.customer.findMany({ where: { agencyId } }));
  const convs = (agencyId: string) => db.tenant(agencyId, (tx) => tx.conversation.findMany({ where: { agencyId } }));

  async function coexistence(label: string) {
    const T = await onboard(app, sa, label, { connect: false });
    const waba = `WABA-${uid()}`, phone = `PN-${uid()}`, code = `code-${uid()}`;
    fake.codes.set(code, { wabaId: waba, phoneNumberId: phone });
    const st = await T.admin.post('/agency/whatsapp/embedded/start', {});
    const r = await T.admin.post('/agency/whatsapp/embedded/complete', { attemptId: st.body.attemptId, state: st.body.state, code, event: { type: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', wabaId: waba, phoneNumberId: phone }, displayName: `${label} line` });
    if (r.status !== 201) throw new Error(`coexistence onboarding failed ${JSON.stringify(r.body)}`);
    signupIds.add(waba); signupIds.add(phone);
    return Object.assign(T, { waba, phone });
  }

  beforeAll(async () => {
    for (const k of FLAG) saved[k] = process.env[k];
    Object.assign(process.env, { WHATSAPP_EMBEDDED_SIGNUP_ENABLED: 'true', WHATSAPP_APP_ID: 'test-primary-app', WHATSAPP_SIGNUP_APP_ID: 'test-signup-app', WHATSAPP_SIGNUP_APP_SECRET: 'test-signup-secret', WHATSAPP_SIGNUP_VERIFY_TOKEN: 'test-signup-verify', WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: 'test-config-id' });
    resetConfigForTests();
    fake = new FakeCloud();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(WHATSAPP).useValue(fake).compile();
    app = configureApp(mod.createNestApplication({ bodyParser: false, logger: false }));
    await app.init();
    db = app.get(Db);
    sa = await superAdmin(app);
    C = await coexistence('CoexC');
    C2 = await coexistence('CoexD');
    const m = await onboard(app, sa, 'ManualM', { connect: false });
    const waba = `WABA-${uid()}`, phone = `PN-${uid()}`;
    expect((await m.admin.post('/agency/whatsapp/connect', { displayName: 'Manual line', wabaId: waba, phoneNumberId: phone, accessToken: 'EAAG-manual-token-value' })).status).toBe(201);
    M = Object.assign(m, { waba, phone });
  });
  afterAll(async () => { await app.close(); for (const k of FLAG) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetConfigForTests(); });

  describe('smb_message_echoes', () => {
    it('records a message sent from the WhatsApp Business app as outbound, without opening the 24h window or raising unread', async () => {
      const to = `+9198${uid().replace(/\D/g, '1').padEnd(8, '1').slice(0, 8)}`;
      const id = `wamid.E-${uid()}`;
      const r = await hook(echo(C, to, id));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ processed: 1, duplicates: 0 });
      const m = (await msgs(C.agencyId)).find((x) => x.providerMessageId === id)!;
      expect(m).toMatchObject({ direction: 'outbound', status: 'sent', text: 'Sent from the app', sentByUserId: null, simulated: false });
      const cv = (await convs(C.agencyId)).find((c) => c.id === m.conversationId)!;
      expect(cv.lastInboundAt).toBeNull(); // an echo is not a customer message
      expect(cv.unreadCount).toBe(0);
      expect((await customers(C.agencyId)).some((c) => c.phoneE164 === to)).toBe(true);
    });

    it('ignores a replayed echo', async () => {
      const to = '+919811100001', id = `wamid.E-${uid()}`;
      await hook(echo(C, to, id));
      const again = await hook(echo(C, to, id));
      expect(again.body).toMatchObject({ processed: 0, duplicates: 1 });
      expect((await msgs(C.agencyId)).filter((x) => x.providerMessageId === id)).toHaveLength(1);
    });

    it('does not store edits or revocations as new messages', async () => {
      const before = (await msgs(C.agencyId)).length;
      const r = await hook(echo(C, '+919811100002', `wamid.R-${uid()}`, { type: 'revoke', text: undefined, revoke: { original_message_id: 'wamid.X' } }));
      expect(r.body).toMatchObject({ processed: 0, ignored: 1 });
      expect((await msgs(C.agencyId)).length).toBe(before);
    });

    it('is ignored for accounts that were not onboarded as coexistence numbers', async () => {
      const before = (await msgs(M.agencyId)).length;
      const r = await hook(echo(M, '+919811100003'));
      expect(r.body).toMatchObject({ processed: 0, ignored: 1 });
      expect((await msgs(M.agencyId)).length).toBe(before);
      expect((await customers(M.agencyId)).some((c) => c.phoneE164 === '+919811100003')).toBe(false);
    });

    it('lands only in the agency that owns the destination number (tenant isolation)', async () => {
      const to = '+919811100004', id = `wamid.E-${uid()}`;
      await hook(echo(C2, to, id));
      expect((await msgs(C2.agencyId)).some((m) => m.providerMessageId === id)).toBe(true);
      expect((await msgs(C.agencyId)).some((m) => m.providerMessageId === id)).toBe(false);
      expect((await customers(C.agencyId)).some((c) => c.phoneE164 === to)).toBe(false);
    });

    it('an unknown number is ignored safely', async () => {
      const r = await hook(echo({ phone: `PN-${uid()}`, waba: 'x' }, '+919811100005'));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ processed: 0, unknown: 1 });
    });
  });

  describe('history', () => {
    const chunk = (t: { phone: string; waba: string }, customer: string, ids: string[], progress = 50) => wrap(t.phone, t.waba, 'history', {
      history: [{ metadata: { phase: 0, chunk_order: 1, progress }, threads: [{ id: customer.slice(1), messages: [
        { from: customer.slice(1), id: ids[0], timestamp: String(Math.floor(Date.now() / 1000) - 90 * 86400), type: 'text', text: { body: 'Old question' }, history_context: { status: 'READ' } },
        { from: '919800000000', id: ids[1], timestamp: String(Math.floor(Date.now() / 1000) - 90 * 86400 + 60), type: 'text', text: { body: 'Old answer' }, history_context: { status: 'READ' } },
      ] }] }],
    });

    it('imports past chats once: correct direction and status, no unread, and the service window stays closed', async () => {
      const cust = '+919822200001', ids = [`wamid.H-${uid()}`, `wamid.H-${uid()}`];
      const r = await hook(chunk(C, cust, ids));
      expect(r.body).toMatchObject({ processed: 2, duplicates: 0 });
      const ms = (await msgs(C.agencyId)).filter((m) => ids.includes(m.providerMessageId ?? ''));
      expect(ms.map((m) => [m.direction, m.status, m.text])).toEqual([['inbound', 'received', 'Old question'], ['outbound', 'read', 'Old answer']]);
      expect(ms[0].createdAt.getTime()).toBeLessThan(Date.now() - 60 * 86400 * 1000); // keeps its original time
      const cv = (await convs(C.agencyId)).find((c) => c.id === ms[0].conversationId)!;
      expect(cv.unreadCount).toBe(0);
      expect(Date.now() - cv.lastInboundAt!.getTime()).toBeGreaterThan(24 * 3600 * 1000); // a 90-day-old message does not open the window
    });

    it('is idempotent when Meta redelivers a chunk', async () => {
      const cust = '+919822200002', ids = [`wamid.H-${uid()}`, `wamid.H-${uid()}`];
      await hook(chunk(C, cust, ids));
      const again = await hook(chunk(C, cust, ids));
      expect(again.body).toMatchObject({ processed: 0, duplicates: 2 });
      expect((await msgs(C.agencyId)).filter((m) => ids.includes(m.providerMessageId ?? ''))).toHaveLength(2);
    });

    it('imports into the owning agency only, and is ignored for non-coexistence accounts', async () => {
      const ids = [`wamid.H-${uid()}`, `wamid.H-${uid()}`];
      await hook(chunk(M, '+919822200003', ids));
      expect((await msgs(M.agencyId)).some((m) => ids.includes(m.providerMessageId ?? ''))).toBe(false);
      await hook(chunk(C2, '+919822200003', ids));
      expect((await msgs(C2.agencyId)).filter((m) => ids.includes(m.providerMessageId ?? ''))).toHaveLength(2);
      expect((await msgs(C.agencyId)).some((m) => ids.includes(m.providerMessageId ?? ''))).toBe(false);
    });

    it('records a declined history share (error 2593109) without failing or importing anything', async () => {
      const before = (await msgs(C.agencyId)).length;
      const r = await hook(wrap(C.phone, C.waba, 'history', { history: [{ errors: [{ code: 2593109, title: 'History sync is turned off by the business from the WhatsApp Business App' }] }] }));
      expect(r.status).toBe(200);
      expect((await msgs(C.agencyId)).length).toBe(before);
      expect((await acct(C.agencyId)).lastErrorCode).toBe('history:2593109');
      expect((await acct(C.agencyId)).connectionStatus).toBe('connected'); // informational, not a failure of the connection
    });
  });

  describe('smb_app_state_sync (contacts)', () => {
    const sync = (t: { phone: string; waba: string }, items: object[]) => wrap(t.phone, t.waba, 'smb_app_state_sync', { state_sync: items });
    const ts = () => String(Math.floor(Date.now() / 1000));

    it('adds contacts as customers, keeps existing names, and never deletes on removal', async () => {
      const phone = '16505551234', e164 = '+16505551234';
      const first = await hook(sync(C, [{ type: 'contact', contact: { full_name: 'Pablo Morales', first_name: 'Pablo', phone_number: phone }, action: 'add', metadata: { timestamp: ts() } }]));
      expect(first.body).toMatchObject({ processed: 1 });
      expect((await customers(C.agencyId)).find((c) => c.phoneE164 === e164)?.name).toBe('Pablo Morales');
      // Renamed in the phone's address book later: TripOS keeps its own record.
      await hook(sync(C, [{ type: 'contact', contact: { full_name: 'Pablo Renamed', phone_number: phone }, action: 'add', metadata: { timestamp: String(Number(ts()) + 5) } }]));
      expect((await customers(C.agencyId)).find((c) => c.phoneE164 === e164)?.name).toBe('Pablo Morales');
      const rm = await hook(sync(C, [{ type: 'contact', contact: { phone_number: phone }, action: 'remove', metadata: { timestamp: String(Number(ts()) + 10) } }]));
      expect(rm.body).toMatchObject({ processed: 0, ignored: 1 });
      expect((await customers(C.agencyId)).some((c) => c.phoneE164 === e164)).toBe(true);
    });

    it('ignores a replayed contact event and non-coexistence accounts', async () => {
      const item = { type: 'contact', contact: { full_name: 'Replay Person', phone_number: '16505559876' }, action: 'add', metadata: { timestamp: '1739321024' } };
      await hook(sync(C, [item]));
      expect((await hook(sync(C, [item]))).body).toMatchObject({ processed: 0, duplicates: 1 });
      await hook(sync(M, [item]));
      expect((await customers(M.agencyId)).some((c) => c.phoneE164 === '+16505559876')).toBe(false);
      expect((await customers(C2.agencyId)).some((c) => c.phoneE164 === '+16505559876')).toBe(false);
    });
  });

  describe('PARTNER_REMOVED', () => {
    const removed = (waba: string, entryId = waba, reason = 'PRIMARY_INACTIVITY', time = Math.floor(Date.now() / 1000)) =>
      ({ object: 'whatsapp_business_account', entry: [{ id: entryId, time, changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED', waba_info: { waba_id: waba, owner_business_id: 'OWNER' }, disconnection_info: { reason, initiated_by: 'SYSTEM' } } }] }] });

    it('disconnects an Embedded Signup account and erases its now-useless credential, leaving others alone', async () => {
      const T = await coexistence('Removed');
      const r = await hook(removed(T.waba, 'PARTNER_BUSINESS_ID')); // entry.id is a partner business, not the WABA
      expect(r.body).toMatchObject({ processed: 1 });
      const a = await acct(T.agencyId);
      expect(a).toMatchObject({ connectionStatus: 'disconnected', credentialSecretRef: null, webhookSubscribed: false, lastErrorCode: 'PARTNER_REMOVED' });
      expect(a.statusReason).toMatch(/primary inactivity/i);
      const audits = await db.tenant(T.agencyId, (tx) => tx.auditLog.findMany({ where: { agencyId: T.agencyId, action: 'whatsapp.partner_removed' } }));
      expect(audits).toHaveLength(1);
      // Other agencies are untouched.
      expect((await acct(C.agencyId)).connectionStatus).toBe('connected');
      expect((await acct(C2.agencyId)).connectionStatus).toBe('connected');
      expect((await acct(M.agencyId)).connectionStatus).toBe('connected');
      // After a disconnect, further events for it are ignored, and the admin can connect again.
      expect((await hook(echo(T, '+919833300001'))).body).toMatchObject({ processed: 0, ignored: 1 });
      expect((await T.admin.get('/agency/whatsapp')).body).toMatchObject({ connected: false, connectionStatus: 'disconnected' });
    });

    it('only degrades a manually connected account and keeps its credential', async () => {
      const m = await onboard(app, sa, 'ManualRemoved', { connect: false });
      const waba = `WABA-${uid()}`, phone = `PN-${uid()}`;
      await m.admin.post('/agency/whatsapp/connect', { displayName: 'Manual line', wabaId: waba, phoneNumberId: phone, accessToken: 'EAAG-keep-me-token' });
      await hook(removed(waba));
      const a = await acct(m.agencyId);
      expect(a.connectionStatus).toBe('degraded');
      expect(a.statusReason).toMatch(/connect again/i);
      expect(decryptSecret(a.credentialSecretRef!)).toBe('EAAG-keep-me-token');
    });

    it('is applied once even if Meta redelivers it, and unknown accounts are ignored', async () => {
      const T = await coexistence('RemovedTwice');
      const time = Math.floor(Date.now() / 1000);
      await hook(removed(T.waba, T.waba, 'USER_RE_REGISTERED', time));
      const again = await hook(removed(T.waba, T.waba, 'USER_RE_REGISTERED', time));
      expect(again.status).toBe(200);
      const audits = await db.tenant(T.agencyId, (tx) => tx.auditLog.findMany({ where: { agencyId: T.agencyId, action: 'whatsapp.partner_removed' } }));
      expect(audits).toHaveLength(1);
      const unknown = await hook(removed(`WABA-${uid()}`));
      expect(unknown.body).toMatchObject({ processed: 0, unknown: 1 });
    });
  });

  describe('connection preservation', () => {
    it('regular customer messages and statuses on the manual account behave exactly as before', async () => {
      const id = `in-${uid()}`;
      const r = await hook(wrap(M.phone, M.waba, 'messages', {
        contacts: [{ wa_id: '919844400001', profile: { name: 'Plain Customer' } }],
        messages: [{ id, from: '919844400001', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hello' } }],
      }));
      expect(r.body).toMatchObject({ processed: 1 });
      const m = (await msgs(M.agencyId)).find((x) => x.providerMessageId === id)!;
      expect(m).toMatchObject({ direction: 'inbound', status: 'received' });
      expect((await acct(M.agencyId))).toMatchObject({ connectionStatus: 'connected', onboardingMethod: 'manual', isCoexistence: false });
    });
  });
});
