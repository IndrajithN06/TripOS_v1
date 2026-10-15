import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { resetConfigForTests } from '../src/config/config';
import { Db } from '../src/db/db.service';
import { configureApp } from '../src/main';
import { metaSignatureHeader } from '../src/providers/whatsapp/signature';
import { WHATSAPP } from '../src/providers/whatsapp/whatsapp';
import { SignedFakeCloud } from './fake-cloud';
import { Client, onboard, superAdmin, Tenant, uid } from './helpers';

// Two Meta apps, one API. Webhook signatures are REALLY verified here (HMAC-SHA256 of the raw body), per route, with throwaway secrets.
// Meta itself is a fake: nothing can reach the real service.
const KEYS = ['WHATSAPP_APP_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_SIGNUP_APP_ID', 'WHATSAPP_SIGNUP_APP_SECRET', 'WHATSAPP_SIGNUP_VERIFY_TOKEN', 'WHATSAPP_EMBEDDED_SIGNUP_ENABLED', 'WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID'] as const;
const TEST_ENV = {
  WHATSAPP_APP_ID: 'e2e-primary-app', WHATSAPP_APP_SECRET: 'e2e-primary-secret', WHATSAPP_VERIFY_TOKEN: 'e2e-primary-verify',
  WHATSAPP_SIGNUP_APP_ID: 'e2e-signup-app', WHATSAPP_SIGNUP_APP_SECRET: 'e2e-signup-secret', WHATSAPP_SIGNUP_VERIFY_TOKEN: 'e2e-signup-verify',
  WHATSAPP_EMBEDDED_SIGNUP_ENABLED: 'true', WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: 'e2e-config',
};
const saved: Record<string, string | undefined> = {};
const PRIMARY = '/webhooks/whatsapp', SIGNUP = '/webhooks/whatsapp/signup';

describe('Two Meta apps: webhook routes and account isolation', () => {
  let app: INestApplication, sa: Client, fake: SignedFakeCloud, db: Db;
  let M: Tenant & { waba: string; phone: string }; // manual connection -> primary app (metaAppId NULL)
  let C: Tenant & { waba: string; phone: string }; // Embedded Signup -> signup app

  const signedPost = (route: string, body: object, secret?: string, tamper = false) => {
    const raw = JSON.stringify(body);
    const r = request(app.getHttpServer()).post(route).set('Content-Type', 'application/json');
    if (secret) r.set('x-hub-signature-256', metaSignatureHeader(Buffer.from(raw), secret));
    return r.send(tamper ? raw.replace('"text":{"body":"', '"text":{"body":"x') : raw);
  };
  const A = 'e2e-primary-secret', B = 'e2e-signup-secret';
  const inbound = (t: { waba: string; phone: string }, id: string, from = '919855500001') => ({
    object: 'whatsapp_business_account',
    entry: [{ id: t.waba, time: Math.floor(Date.now() / 1000), changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: t.phone }, contacts: [{ wa_id: from, profile: { name: 'Pat' } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hello' } }] } }] }],
  });
  const stored = (agencyId: string, id: string) => db.tenant(agencyId, (tx) => tx.message.findFirst({ where: { agencyId, providerMessageId: id } }));
  const acct = (agencyId: string) => db.tenant(agencyId, (tx) => tx.whatsappAccount.findFirstOrThrow({ where: { agencyId } }));

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, TEST_ENV);
    resetConfigForTests();
    fake = new SignedFakeCloud();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(WHATSAPP).useValue(fake).compile();
    app = configureApp(mod.createNestApplication({ bodyParser: false, logger: false }));
    await app.init();
    db = app.get(Db);
    sa = await superAdmin(app);

    const m = await onboard(app, sa, 'TwoAppM', { connect: false });
    const mw = { waba: `WABA-${uid()}`, phone: `PN-${uid()}` };
    expect((await m.admin.post('/agency/whatsapp/connect', { displayName: 'Manual line', wabaId: mw.waba, phoneNumberId: mw.phone, accessToken: 'EAAG-manual-token-value' })).status).toBe(201);
    M = Object.assign(m, mw);

    const c = await onboard(app, sa, 'TwoAppC', { connect: false });
    const cw = { waba: `WABA-${uid()}`, phone: `PN-${uid()}`, code: `code-${uid()}` };
    fake.codes.set(cw.code, { wabaId: cw.waba, phoneNumberId: cw.phone });
    const st = await c.admin.post('/agency/whatsapp/embedded/start', {});
    const done = await c.admin.post('/agency/whatsapp/embedded/complete', { attemptId: st.body.attemptId, state: st.body.state, code: cw.code, event: { type: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', wabaId: cw.waba, phoneNumberId: cw.phone }, displayName: 'Signup line' });
    expect(done.status).toBe(201);
    C = Object.assign(c, { waba: cw.waba, phone: cw.phone });
  });
  afterAll(async () => { await app.close(); for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetConfigForTests(); });

  describe('which app each account belongs to', () => {
    it('a manual connection records no app (NULL = primary); an Embedded Signup connection records the signup app', async () => {
      expect((await acct(M.agencyId)).metaAppId).toBeNull();
      expect((await acct(C.agencyId)).metaAppId).toBe('e2e-signup-app');
    });
  });

  describe('each route trusts only its own app', () => {
    it('primary route: a primary-signed event for a primary account is applied', async () => {
      const id = `in-${uid()}`;
      const r = await signedPost(PRIMARY, inbound(M, id), A);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ processed: 1 });
      expect(await stored(M.agencyId, id)).not.toBeNull();
    });
    it('signup route: a signup-signed event for a signup account is applied', async () => {
      const id = `in-${uid()}`;
      const r = await signedPost(SIGNUP, inbound(C, id), B);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ processed: 1 });
      expect(await stored(C.agencyId, id)).not.toBeNull();
    });
    it('cross-signed requests are rejected on both routes (a valid signature of the OTHER app is not enough)', async () => {
      const m = `in-${uid()}`, c = `in-${uid()}`;
      expect((await signedPost(PRIMARY, inbound(M, m), B)).status).toBe(401);
      expect((await signedPost(SIGNUP, inbound(C, c), A)).status).toBe(401);
      expect(await stored(M.agencyId, m)).toBeNull();
      expect(await stored(C.agencyId, c)).toBeNull();
    });
    it('unsigned and tampered requests are rejected on both routes', async () => {
      const m = `in-${uid()}`, c = `in-${uid()}`;
      expect((await signedPost(PRIMARY, inbound(M, m))).status).toBe(401);
      expect((await signedPost(SIGNUP, inbound(C, c))).status).toBe(401);
      expect((await signedPost(PRIMARY, inbound(M, m), A, true)).status).toBe(401);
      expect((await signedPost(SIGNUP, inbound(C, c), B, true)).status).toBe(401);
      expect(await stored(M.agencyId, m)).toBeNull();
      expect(await stored(C.agencyId, c)).toBeNull();
    });
  });

  describe('account-to-app isolation: a valid signature from one app cannot touch the other app\'s accounts', () => {
    it('a correctly signed SIGNUP-route event for a primary account is ignored', async () => {
      const id = `in-${uid()}`;
      const r = await signedPost(SIGNUP, inbound(M, id), B);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ processed: 0, ignored: 1 });
      expect(await stored(M.agencyId, id)).toBeNull();
    });
    it('a correctly signed PRIMARY-route event for a signup account is ignored', async () => {
      const id = `in-${uid()}`;
      const r = await signedPost(PRIMARY, inbound(C, id), A);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ processed: 0, ignored: 1 });
      expect(await stored(C.agencyId, id)).toBeNull();
    });
    it('a PARTNER_REMOVED on the wrong route does not disconnect anything', async () => {
      const removed = (waba: string) => ({ object: 'whatsapp_business_account', entry: [{ id: 'PARTNER_BIZ', time: Math.floor(Date.now() / 1000), changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED', waba_info: { waba_id: waba }, disconnection_info: { reason: 'USER_RE_REGISTERED', initiated_by: 'USER' } } }] }] });
      await signedPost(PRIMARY, removed(C.waba), A);   // signup account, primary route
      await signedPost(SIGNUP, removed(M.waba), B);    // primary account, signup route
      expect((await acct(C.agencyId)).connectionStatus).toBe('connected');
      expect((await acct(M.agencyId)).connectionStatus).toBe('connected');
    });
    it('an unknown number is acknowledged on both routes and changes nothing', async () => {
      const ghost = { waba: `WABA-${uid()}`, phone: `PN-${uid()}` };
      expect((await signedPost(PRIMARY, inbound(ghost, `in-${uid()}`), A)).body).toMatchObject({ processed: 0, unknown: 1 });
      expect((await signedPost(SIGNUP, inbound(ghost, `in-${uid()}`), B)).body).toMatchObject({ processed: 0, unknown: 1 });
    });
  });

  describe('verification handshake', () => {
    const verify = (route: string, token: string) => request(app.getHttpServer()).get(route).query({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': 'CH123' });
    it('each route accepts only its own verify token', async () => {
      expect((await verify(PRIMARY, 'e2e-primary-verify')).text).toBe('CH123');
      expect((await verify(SIGNUP, 'e2e-signup-verify')).text).toBe('CH123');
      expect((await verify(PRIMARY, 'e2e-signup-verify')).status).toBe(403);
      expect((await verify(SIGNUP, 'e2e-primary-verify')).status).toBe(403);
      expect((await verify(SIGNUP, 'wrong')).status).toBe(403);
    });
  });

  describe('the signup route is optional and the primary route does not depend on it', () => {
    it('without signup credentials the signup route is 404 while the primary route keeps working', async () => {
      const keep = { id: process.env.WHATSAPP_SIGNUP_APP_ID, sec: process.env.WHATSAPP_SIGNUP_APP_SECRET, tok: process.env.WHATSAPP_SIGNUP_VERIFY_TOKEN, flag: process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED };
      for (const k of ['WHATSAPP_SIGNUP_APP_ID', 'WHATSAPP_SIGNUP_APP_SECRET', 'WHATSAPP_SIGNUP_VERIFY_TOKEN']) delete process.env[k];
      process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED = 'false';
      resetConfigForTests();
      try {
        const id = `in-${uid()}`;
        expect((await signedPost(SIGNUP, inbound(C, `in-${uid()}`), B)).status).toBe(404);
        expect((await request(app.getHttpServer()).get(SIGNUP).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'e2e-signup-verify', 'hub.challenge': 'x' })).status).toBe(404);
        const r = await signedPost(PRIMARY, inbound(M, id), A);
        expect(r.status).toBe(200);
        expect(await stored(M.agencyId, id)).not.toBeNull();
      } finally {
        Object.assign(process.env, { WHATSAPP_SIGNUP_APP_ID: keep.id, WHATSAPP_SIGNUP_APP_SECRET: keep.sec, WHATSAPP_SIGNUP_VERIFY_TOKEN: keep.tok, WHATSAPP_EMBEDDED_SIGNUP_ENABLED: keep.flag });
        resetConfigForTests();
      }
    });
  });

  describe('an account tied to a Meta app that is not configured here is never silently dropped (H2)', () => {
    it('answers 503 so Meta retries, flags the account degraded once with a clear reason, and recovers when the app is configured again', async () => {
      const set = (data: object) => db.tenant(C.agencyId, (tx) => tx.whatsappAccount.updateMany({ where: { agencyId: C.agencyId }, data }));
      await set({ metaAppId: 'e2e-rotated-away-app' });
      try {
        const id = `in-${uid()}`;
        const r1 = await signedPost(SIGNUP, inbound(C, id), B);
        expect(r1.status).toBe(503);
        expect(r1.body.error.code).toBe('app_unrecognised');
        expect(await stored(C.agencyId, id)).toBeNull(); // nothing applied, so the retry will not duplicate anything
        const flagged = await acct(C.agencyId);
        expect(flagged).toMatchObject({ connectionStatus: 'degraded', lastErrorCode: 'APP_UNRECOGNISED' });
        expect(flagged.statusReason).toMatch(/not configured on this server/);
        // The same event again (Meta's retry): still 503, and the row is not rewritten.
        const r2 = await signedPost(SIGNUP, inbound(C, id), B);
        expect(r2.status).toBe(503);
        expect((await acct(C.agencyId)).lastErrorAt).toEqual(flagged.lastErrorAt);
        // A wrong-route event for a KNOWN app stays a plain 200 (it is not an error on our side).
        expect((await signedPost(PRIMARY, inbound(M, `in-${uid()}`), A)).status).toBe(200);
        // Configuration repaired: the same retry now succeeds.
        await set({ metaAppId: 'e2e-signup-app' });
        const r3 = await signedPost(SIGNUP, inbound(C, id), B);
        expect(r3.status).toBe(200);
        expect(await stored(C.agencyId, id)).not.toBeNull();
      } finally {
        await set({ metaAppId: 'e2e-signup-app', connectionStatus: 'connected', lastErrorCode: null, statusReason: null });
      }
    });
  });

});
