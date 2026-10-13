import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { Db } from '../src/db/db.service';
import {
  parseCloudPayload, WaAccount, WaPhoneInfo, WaRemoteTemplate, WaSendError, WaSendResult, WHATSAPP, WhatsAppProvider,
} from '../src/providers/whatsapp/whatsapp';
import { Client, onboard, superAdmin, Tenant, uid } from './helpers';

/** Stand-in for the Meta Cloud API with the provider's real shape: lets us exercise "cloud mode" code paths offline. */
class FakeCloud implements WhatsAppProvider {
  readonly name = 'cloud' as const;
  readonly simulated = false;
  phoneInfo: WaPhoneInfo = { displayPhoneNumber: '+91 98000 00000', verifiedName: 'Test Travels', displayNameStatus: 'APPROVED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K', status: 'CONNECTED' };
  infoError?: WaSendError; subscribeError?: WaSendError; sendError?: WaSendError; submitError?: WaSendError;
  templates: WaRemoteTemplate[] = [];
  calls: string[] = [];
  seen: WaAccount[] = [];
  private n = 0;
  private ok(): WaSendResult { return { providerMessageId: `wamid.fake.${++this.n}`, simulated: false }; }
  private send(a: WaAccount, what: string) { this.calls.push(what); this.seen.push(a); if (this.sendError) throw this.sendError; return this.ok(); }
  async sendText(a: WaAccount) { return this.send(a, 'text'); }
  async sendDocument(a: WaAccount) { return this.send(a, 'document'); }
  async sendImage(a: WaAccount) { return this.send(a, 'image'); }
  async sendTemplate(a: WaAccount) { return this.send(a, 'template'); }
  async downloadMedia() { return { data: Buffer.from('x'), mimeType: 'image/png' }; }
  verifySignature() { return true; }
  parseWebhook(b: any) { return parseCloudPayload(b); }
  async getPhoneInfo(a: WaAccount) { this.calls.push('info'); this.seen.push(a); if (this.infoError) throw this.infoError; return this.phoneInfo; }
  async subscribeWebhooks(a: WaAccount) { this.calls.push('subscribe'); this.seen.push(a); if (this.subscribeError) throw this.subscribeError; }
  async listTemplates() { this.calls.push('list'); return this.templates; }
  async uploadTemplateExample() { return '4::handle'; }
  async submitTemplate(_a: WaAccount, t: { name: string }) { this.calls.push('submit'); if (this.submitError) throw this.submitError; return { providerTemplateId: `meta-${t.name}`, status: 'PENDING' }; }
}

const authError = () => new WaSendError('Invalid OAuth access token', '190', false, 'auth');
const TOKEN = 'EAAG-super-secret-token-value';

describe('Real WhatsApp mode (fake Meta provider): connect, health, templates, webhooks', () => {
  let app: INestApplication, sa: Client, fake: FakeCloud, A: Tenant, B: Tenant, wabaA: string, phoneA: string;
  const post = (body: object) => request(app.getHttpServer()).post('/webhooks/whatsapp').send(body);
  const connectBody = (over: object = {}) => ({ displayName: 'Real line', wabaId: wabaA, phoneNumberId: phoneA, accessToken: TOKEN, ...over });
  const tplEvent = (waba: string, id: string, event: string, extra: object = {}) => ({ entry: [{ id: waba, time: Math.floor(Date.now() / 1000), changes: [{ field: 'message_template_status_update', value: { event, message_template_id: id, ...extra } }] }] });
  const acct = (agencyId: string) => app.get(Db).tenant(agencyId, (tx) => tx.whatsappAccount.findFirstOrThrow({ where: { agencyId } }));

  beforeAll(async () => {
    fake = new FakeCloud();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(WHATSAPP).useValue(fake).compile();
    app = configureApp(mod.createNestApplication({ bodyParser: false, logger: false }));
    await app.init();
    sa = await superAdmin(app);
    A = await onboard(app, sa, 'RealA', { connect: false });
    B = await onboard(app, sa, 'RealB', { connect: false });
    wabaA = `WABA-${uid()}`; phoneA = `PN-${uid()}`;
  });
  afterAll(async () => { await app.close(); });

  describe('connecting', () => {
    it('rejects a bad token with a clear message and stores nothing', async () => {
      fake.infoError = authError();
      const r = await A.admin.post('/agency/whatsapp/connect', connectBody());
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('whatsapp_auth_failed');
      expect(r.body.error.message).toMatch(/Invalid OAuth access token/);
      expect((await A.admin.get('/agency/whatsapp')).body.connected).toBe(false);
      fake.infoError = undefined;
    });

    it('rejects when the webhook subscription fails (e.g. missing permission) and stores nothing', async () => {
      fake.subscribeError = new WaSendError('(#200) Requires whatsapp_business_management permission', '200', false, 'auth');
      const r = await A.admin.post('/agency/whatsapp/connect', connectBody());
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/subscribe/i);
      expect((await A.admin.get('/agency/whatsapp')).body.connected).toBe(false);
      fake.subscribeError = undefined;
    });

    it('validates the number, subscribes the webhook, stores the token encrypted and never returns it', async () => {
      fake.templates = [
        { providerTemplateId: 'm1', name: 'quote_followup', language: 'en', category: 'UTILITY', status: 'APPROVED', body: 'Hi {{1}}, any update on {{2}}?' },
        { providerTemplateId: 'm2', name: 'promo_offer', language: 'en', category: 'MARKETING', status: 'REJECTED', body: 'Big sale', rejectedReason: 'INVALID_FORMAT' },
      ];
      fake.calls.length = 0;
      const r = await A.admin.post('/agency/whatsapp/connect', connectBody());
      expect(r.status).toBe(201);
      expect(fake.calls).toEqual(expect.arrayContaining(['info', 'subscribe', 'list']));
      expect(r.body).toMatchObject({ connected: true, mode: 'cloud', connectionStatus: 'connected', webhookSubscribed: true, hasCredential: true, qualityRating: 'GREEN', displayNameStatus: 'APPROVED', messagingLimitTier: 'TIER_1K', wabaId: wabaA, phoneNumberId: phoneA });
      expect(JSON.stringify(r.body)).not.toContain(TOKEN);
      expect(JSON.stringify((await A.admin.get('/agency/whatsapp')).body)).not.toContain(TOKEN);
      const row = await acct(A.agencyId);
      expect(row.credentialSecretRef).toBeTruthy();
      expect(row.credentialSecretRef).not.toContain(TOKEN);
      expect(fake.seen.some((s) => s.token === TOKEN && s.wabaId === wabaA)).toBe(true); // decrypted only when calling Meta
    });

    it('pulled templates created in Meta\'s manager, with their provider states', async () => {
      const t = (await A.admin.get('/agency/whatsapp/templates')).body as any[];
      expect(t.find((x) => x.name === 'quote_followup')).toMatchObject({ providerStatus: 'approved', providerTemplateId: 'm1' });
      expect(t.find((x) => x.name === 'quote_followup').variableSchema).toHaveLength(2);
      expect(t.find((x) => x.name === 'promo_offer')).toMatchObject({ providerStatus: 'rejected', rejectedReason: 'INVALID_FORMAT' });
    });

    it('does not allow one WhatsApp number or business account to be linked to two agencies', async () => {
      expect((await B.admin.post('/agency/whatsapp/connect', connectBody())).status).toBe(409);
      expect((await B.admin.post('/agency/whatsapp/connect', connectBody({ phoneNumberId: `PN-${uid()}` }))).status).toBe(409); // same WABA
      expect((await B.admin.get('/agency/whatsapp')).body.connected).toBe(false);
    });

    it('requires the cloud fields', async () => {
      const r = await B.admin.post('/agency/whatsapp/connect', { displayName: 'x line' });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('missing_fields');
    });

    it('is admin-only', async () => {
      for (const r of await Promise.all([A.sales.post('/agency/whatsapp/connect', connectBody()), A.sales.post('/agency/whatsapp/refresh'), A.sales.post('/agency/whatsapp/disconnect'), A.sales.post('/agency/whatsapp/templates/sync')])) expect(r.status).toBe(403);
    });
  });

  describe('templates', () => {
    let draftId: string;
    it('submits a draft to Meta and stores the provider\'s PENDING state (not approved)', async () => {
      draftId = (await A.admin.post('/agency/whatsapp/templates', { name: 'trip_reminder', body: 'Hi {{1}}, your trip is tomorrow, see you at {{2}}', variableSchema: ['name', 'place'] })).body.id;
      const r = await A.admin.post(`/agency/whatsapp/templates/${draftId}/submit`);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ providerStatus: 'pending', providerTemplateId: 'meta-trip_reminder' });
    });
    it('cannot resubmit while pending; a rejected template can be resubmitted', async () => {
      expect((await A.admin.post(`/agency/whatsapp/templates/${draftId}/submit`)).status).toBe(400);
      await post(tplEvent(wabaA, 'meta-trip_reminder', 'REJECTED', { reason: 'INCORRECT_CATEGORY' }));
      const t = (await A.admin.get('/agency/whatsapp/templates')).body.find((x: any) => x.id === draftId);
      expect(t).toMatchObject({ providerStatus: 'rejected', rejectedReason: 'INCORRECT_CATEGORY' });
      expect((await A.admin.post(`/agency/whatsapp/templates/${draftId}/submit`)).status).toBe(201);
    });
    it('surfaces Meta\'s rejection of a submission', async () => {
      const id = (await A.admin.post('/agency/whatsapp/templates', { name: 'bad_one', body: 'Hello there friend' })).body.id;
      fake.submitError = new WaSendError('Template name already exists', '100', false, 'unknown');
      const r = await A.admin.post(`/agency/whatsapp/templates/${id}/submit`);
      fake.submitError = undefined;
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/already exists/);
      expect((await A.admin.get('/agency/whatsapp/templates')).body.find((x: any) => x.id === id).providerStatus).toBe('local_draft');
    });
    it('a webhook approval makes it sendable status-wise, and a replayed webhook is not re-applied', async () => {
      const first = await post(tplEvent(wabaA, 'meta-trip_reminder', 'APPROVED'));
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ processed: 1, duplicates: 0 });
      expect((await A.admin.get('/agency/whatsapp/templates')).body.find((x: any) => x.id === draftId)).toMatchObject({ providerStatus: 'approved', rejectedReason: null });
      // Meta retries deliver the identical payload; the second delivery is acknowledged but not re-applied.
      const body = tplEvent(wabaA, 'meta-trip_reminder', 'PAUSED');
      expect((await post(body)).body.processed).toBe(1);
      expect((await post(body)).body.duplicates).toBe(1);
    });
    it('ignores template events for an unknown business account and non-status events', async () => {
      expect((await post(tplEvent('WABA-UNKNOWN', 'x', 'APPROVED'))).body.unknown).toBe(1);
      const before = await acct(A.agencyId);
      await post(tplEvent(wabaA, 'meta-trip_reminder', 'FLAGGED'));
      expect((await A.admin.get('/agency/whatsapp/templates')).body.find((x: any) => x.id === draftId).providerStatus).toBe('paused'); // FLAGGED keeps the current state
      expect(before.connectionStatus).toBe('connected');
    });
    it('manual sync updates statuses from Meta', async () => {
      fake.templates = [{ providerTemplateId: 'm1', name: 'quote_followup', language: 'en', category: 'UTILITY', status: 'PAUSED', body: 'Hi {{1}}, any update on {{2}}?' }];
      const r = await A.admin.post('/agency/whatsapp/templates/sync');
      expect(r.body).toMatchObject({ total: 1, updated: 1, created: 0 });
      expect((await A.admin.get('/agency/whatsapp/templates')).body.find((x: any) => x.name === 'quote_followup').providerStatus).toBe('paused');
    });
  });

  describe('health, failures and recovery', () => {
    it('a revoked token on send flips the connection to degraded, explains why, and shows on /me for everyone', async () => {
      const conv = await seedConversation(app, A, phoneA, '+919700000555');
      fake.sendError = authError();
      const r = await A.sales.post(`/inbox/conversations/${conv}/messages`, { type: 'text', text: 'hello' });
      fake.sendError = undefined;
      expect(r.body.ok).toBe(false);
      expect(r.body.errorMessage).toMatch(/reconnect the WhatsApp account/i);
      const status = (await A.admin.get('/agency/whatsapp')).body;
      expect(status.connectionStatus).toBe('degraded');
      expect(status.statusReason).toMatch(/token/i);
      expect(status.lastErrorCode).toBe('190');
      expect((await A.sales.get('/me')).body.agency.whatsapp).toMatchObject({ status: 'degraded', simulated: false });
    });

    it('a rate-limit or transient error does NOT degrade the connection', async () => {
      await A.admin.post('/agency/whatsapp/refresh'); // recover first
      const conv = (await A.admin.get('/inbox/conversations')).body.items[0].id;
      fake.sendError = new WaSendError('throughput', '130429', true, 'rate_limit');
      await A.admin.post(`/inbox/conversations/${conv}/messages`, { type: 'text', text: 'x' });
      fake.sendError = undefined;
      expect((await A.admin.get('/agency/whatsapp')).body.connectionStatus).toBe('connected');
    });

    it('"Check status now" recovers a degraded connection once the token works again', async () => {
      const conv = (await A.admin.get('/inbox/conversations')).body.items[0].id;
      fake.sendError = authError();
      await A.admin.post(`/inbox/conversations/${conv}/messages`, { type: 'text', text: 'y' });
      fake.sendError = undefined;
      expect((await A.admin.get('/agency/whatsapp')).body.connectionStatus).toBe('degraded');
      const r = await A.admin.post('/agency/whatsapp/refresh');
      expect(r.body).toMatchObject({ connectionStatus: 'connected', statusReason: null, lastErrorCode: null });
    });

    it('a failing health check with a bad token degrades; a restricted number degrades; a RED rating warns but stays connected', async () => {
      fake.infoError = authError();
      expect((await A.admin.post('/agency/whatsapp/refresh')).body.connectionStatus).toBe('degraded');
      fake.infoError = undefined;
      fake.phoneInfo = { ...fake.phoneInfo, status: 'RESTRICTED' };
      expect((await A.admin.post('/agency/whatsapp/refresh')).body).toMatchObject({ connectionStatus: 'degraded' });
      fake.phoneInfo = { ...fake.phoneInfo, status: 'CONNECTED', qualityRating: 'RED' };
      const red = (await A.admin.post('/agency/whatsapp/refresh')).body;
      expect(red.connectionStatus).toBe('connected');
      expect(red.statusReason).toMatch(/RED/);
      fake.phoneInfo = { ...fake.phoneInfo, qualityRating: 'GREEN' };
      expect((await A.admin.post('/agency/whatsapp/refresh')).body.statusReason).toBeNull();
    });

    it('a transient health-check failure keeps the state but records the error', async () => {
      fake.infoError = new WaSendError('Graph is down', '2', true, 'transient');
      const r = (await A.admin.post('/agency/whatsapp/refresh')).body;
      fake.infoError = undefined;
      expect(r.connectionStatus).toBe('connected');
      expect(r.lastErrorCode).toBe('2');
    });

    it('serious account events from Meta degrade the connection', async () => {
      await post({ entry: [{ id: wabaA, time: Math.floor(Date.now() / 1000), changes: [{ field: 'account_update', value: { event: 'DISABLED_UPDATE' } }] }] });
      const s = (await A.admin.get('/agency/whatsapp')).body;
      expect(s.connectionStatus).toBe('degraded');
      expect(s.statusReason).toMatch(/DISABLED_UPDATE/);
      await A.admin.post('/agency/whatsapp/refresh');
    });

    it('records when the last webhook arrived', async () => {
      const before = (await acct(A.agencyId)).lastWebhookAt;
      await post(tplEvent(wabaA, 'meta-trip_reminder', 'APPROVED', { reason: 'NONE' }));
      const after = (await acct(A.agencyId)).lastWebhookAt;
      expect(after).toBeTruthy();
      expect(after!.getTime()).toBeGreaterThanOrEqual(before?.getTime() ?? 0);
    });
  });

  describe('isolation and disconnect', () => {
    it('another agency cannot see or affect this agency\'s connection', async () => {
      expect((await B.admin.get('/agency/whatsapp')).body.connected).toBe(false);
      expect((await B.admin.post('/agency/whatsapp/refresh')).status).toBe(400); // nothing connected for B
      expect((await acct(A.agencyId)).phoneNumberId).toBe(phoneA);
    });

    it('disconnecting erases the credential, blocks sending, and ignores later events', async () => {
      const conv = (await A.admin.get('/inbox/conversations')).body.items[0].id;
      const r = await A.admin.post('/agency/whatsapp/disconnect');
      expect(r.body.ok).toBe(true);
      const s = (await A.admin.get('/agency/whatsapp')).body;
      expect(s).toMatchObject({ connected: false, connectionStatus: 'disconnected', hasCredential: false });
      expect((await acct(A.agencyId)).credentialSecretRef).toBeNull();
      const send = await A.admin.post(`/inbox/conversations/${conv}/messages`, { type: 'text', text: 'nope' });
      expect(send.status).toBe(400);
      expect(send.body.error.code).toBe('whatsapp_not_connected');
      const ev = await post(tplEvent(wabaA, 'meta-trip_reminder', 'APPROVED'));
      expect(ev.body.ignored).toBe(1);
      expect((await A.sales.get('/me')).body.agency.whatsapp.status).toBe('disconnected');
    });

    it('can be reconnected afterwards', async () => {
      const r = await A.admin.post('/agency/whatsapp/connect', connectBody());
      expect(r.status).toBe(201);
      expect(r.body.connectionStatus).toBe('connected');
    });
  });
});

/** An inbound customer message through the webhook, so the conversation exists and its 24 h window is open. */
async function seedConversation(app: INestApplication, t: Tenant, phoneNumberId: string, from: string) {
  await request(app.getHttpServer()).post('/webhooks/whatsapp').send({ entry: [{ id: 'x', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: from.slice(1), profile: { name: 'Cust' } }], messages: [{ id: `in-${uid()}`, from: from.slice(1), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' } }] } }] }] });
  return (await t.admin.get('/inbox/conversations')).body.items[0].id as string;
}
