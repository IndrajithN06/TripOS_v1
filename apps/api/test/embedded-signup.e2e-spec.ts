import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { decryptSecret } from '../src/common/crypto';
import { resetConfigForTests } from '../src/config/config';
import { Db } from '../src/db/db.service';
import { configureApp } from '../src/main';
import { WaSendError, WHATSAPP } from '../src/providers/whatsapp/whatsapp';
import { FakeCloud } from './fake-cloud';
import { Client, onboard, superAdmin, Tenant, uid } from './helpers';

// Embedded Signup v4 + coexistence against a FAKE Meta. Nothing here can reach the real service: the provider is replaced.
const FLAG = ['WHATSAPP_EMBEDDED_SIGNUP_ENABLED', 'WHATSAPP_APP_ID', 'WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID'] as const;
const saved: Record<string, string | undefined> = {};

describe('WhatsApp Embedded Signup (coexistence), fake Meta', () => {
  let app: INestApplication, sa: Client, fake: FakeCloud, db: Db;
  const base = '/agency/whatsapp/embedded';

  const boot = async () => {
    fake = new FakeCloud();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(WHATSAPP).useValue(fake).compile();
    app = configureApp(mod.createNestApplication({ bodyParser: false, logger: false }));
    await app.init();
    db = app.get(Db);
    sa = await superAdmin(app);
  };
  const setFlag = (on: boolean) => {
    process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED = on ? 'true' : 'false';
    process.env.WHATSAPP_APP_ID = 'test-app-id';
    process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID = 'test-config-id';
    resetConfigForTests();
  };
  beforeAll(async () => { for (const k of FLAG) saved[k] = process.env[k]; setFlag(true); await boot(); });
  afterAll(async () => { await app.close(); for (const k of FLAG) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetConfigForTests(); });

  const newTenant = (label: string) => onboard(app, sa, label, { connect: false });
  const ids = () => ({ waba: `WABA-${uid()}`, phone: `PN-${uid()}`, code: `code-${uid()}` });
  const acct = (agencyId: string) => db.tenant(agencyId, (tx) => tx.whatsappAccount.findFirst({ where: { agencyId } }));
  const attemptRow = (agencyId: string, id: string) => db.tenant(agencyId, (tx) => tx.whatsappSignupAttempt.findFirstOrThrow({ where: { id } }));
  const finish = (w: { waba: string; phone: string }, over: object = {}) => ({ type: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', wabaId: w.waba, phoneNumberId: w.phone, businessId: 'BIZ-1', ...over });

  /** start + complete in one go; returns both responses. */
  async function signup(T: Tenant, w = ids(), opts: { fakeFor?: boolean; event?: object; code?: string | null; requestSync?: boolean; isOnBizApp?: boolean; extraPhones?: string[] } = {}) {
    if (opts.fakeFor !== false) fake.codes.set(w.code, { wabaId: w.waba, phoneNumberId: w.phone, isOnBizApp: opts.isOnBizApp ?? true, extraPhones: opts.extraPhones });
    const st = await T.admin.post(`${base}/start`, { requestSync: opts.requestSync ?? false });
    if (st.status !== 201) return { st, done: st, w };
    const done = await T.admin.post(`${base}/complete`, {
      attemptId: st.body.attemptId, state: st.body.state, ...(opts.code === null ? {} : { code: opts.code ?? w.code }), event: opts.event ?? finish(w), displayName: 'Golden Travels',
    });
    return { st, done, w };
  }

  describe('feature flag', () => {
    it('is off by default: nothing is exposed and the manual connection routes are unaffected', async () => {
      setFlag(false);
      try {
        const T = await newTenant('FlagOff');
        expect((await T.admin.get(base)).body).toEqual({ enabled: false });
        const r = await T.admin.post(`${base}/start`, {});
        expect(r.status).toBe(404);
        expect(r.body.error.code).toBe('feature_disabled');
        expect((await T.admin.post('/agency/whatsapp/connect', { displayName: 'Manual still works', wabaId: `WABA-${uid()}`, phoneNumberId: `PN-${uid()}`, accessToken: 'EAAG-manual-token-value' })).status).toBe(201);
        expect((await T.admin.get('/me')).body.environment.whatsappEmbeddedSignup).toBe(false);
      } finally { setFlag(true); }
    });
    it('is reported to the web app when enabled', async () => {
      const T = await newTenant('FlagOn');
      expect((await T.admin.get('/me')).body.environment.whatsappEmbeddedSignup).toBe(true);
      expect((await T.admin.get(base)).body).toMatchObject({ enabled: true, appId: 'test-app-id', configId: 'test-config-id', blockedByExistingConnection: false });
    });
  });

  describe('authorization', () => {
    it('is admin only', async () => {
      const T = await newTenant('Authz');
      for (const r of await Promise.all([T.sales.get(base), T.sales.post(`${base}/start`, {}), T.sales.post(`${base}/complete`, {}), T.sales.post(`${base}/cancel`, {})])) expect(r.status).toBe(403);
    });
    it('requires a login', async () => {
      expect((await request(app.getHttpServer()).get(base)).status).toBe(401);
      expect((await request(app.getHttpServer()).post(`${base}/start`).set('x-tripos-csrf', '1').send({})).status).toBe(401);
    });
    it('takes the agency from the session: a body-supplied agency id has no effect', async () => {
      const A = await newTenant('SpoofA'), B = await newTenant('SpoofB');
      const w = ids(); fake.codes.set(w.code, { wabaId: w.waba, phoneNumberId: w.phone });
      const st = await A.admin.post(`${base}/start`, { requestSync: false, agencyId: B.agencyId });
      await A.admin.post(`${base}/complete`, { attemptId: st.body.attemptId, state: st.body.state, code: w.code, event: finish(w), displayName: 'Mine', agencyId: B.agencyId });
      expect(await acct(B.agencyId)).toBeNull();
      expect((await acct(A.agencyId))?.wabaId).toBe(w.waba);
    });
  });

  describe('successful coexistence onboarding', () => {
    it('exchanges the code on the server, verifies the assets, subscribes, stores the token encrypted and never returns it', async () => {
      const T = await newTenant('Happy');
      const { done, w } = await signup(T);
      expect(done.status).toBe(201);
      expect(done.body).toMatchObject({ status: 'completed', alreadyCompleted: false, account: { connected: true, mode: 'cloud', connectionStatus: 'connected', webhookSubscribed: true, hasCredential: true, onboardingMethod: 'embedded', coexistence: true, wabaId: w.waba, phoneNumberId: w.phone } });
      expect(JSON.stringify(done.body)).not.toContain('EAAG-business');
      expect(fake.exchanged).toContain(w.code);
      expect(fake.subscribed).toContain(w.waba);
      expect(fake.attempted).not.toContain('register'); // the number is never registered or migrated
      const row = await acct(T.agencyId);
      expect(row?.credentialSecretRef).toBeTruthy();
      expect(row?.credentialSecretRef).not.toContain('EAAG');
      expect(decryptSecret(row!.credentialSecretRef!)).toBe(`EAAG-business-${w.code}`);
      expect(row).toMatchObject({ onboardingMethod: 'embedded', isCoexistence: true, businessId: 'BIZ-1', connectedByUserId: T.adminId });
      const a = await attemptRow(T.agencyId, done.body.attempt.id);
      expect(a).toMatchObject({ status: 'completed', step: 'done', tokenRef: null });
      const audits = await db.tenant(T.agencyId, (tx) => tx.auditLog.findMany({ where: { agencyId: T.agencyId, action: 'whatsapp.connected' } }));
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits[0].metadata)).not.toContain('EAAG');
      expect((await T.admin.get('/agency/whatsapp')).body).toMatchObject({ onboardingMethod: 'embedded', coexistence: true });
    });

    it('requests contacts and history sync only when the admin asked for it', async () => {
      const T1 = await newTenant('SyncOn'), T2 = await newTenant('SyncOff');
      const a = ids(), b = ids();
      await signup(T1, a, { requestSync: true });
      await signup(T2, b, { requestSync: false });
      expect(fake.syncs.filter((s) => s.phoneNumberId === a.phone).map((s) => s.syncType)).toEqual(['smb_app_state_sync', 'history']);
      expect(fake.syncs.filter((s) => s.phoneNumberId === b.phone)).toHaveLength(0);
    });

    it('a failed sync request never undoes the connection', async () => {
      const T = await newTenant('SyncFail');
      fake.syncError = new WaSendError('nope', '131000', true, 'transient');
      try {
        const { done } = await signup(T, ids(), { requestSync: true });
        expect(done.status).toBe(201);
        expect(done.body.account.connected).toBe(true);
        expect((await attemptRow(T.agencyId, done.body.attempt.id)).syncStatus).toBe('failed');
      } finally { fake.syncError = undefined; }
    });

    it('works when Meta reports only the WABA (single number is discovered, never guessed)', async () => {
      const T = await newTenant('NoPhone'), w = ids();
      const { done } = await signup(T, w, { event: { type: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', wabaId: w.waba } });
      expect(done.status).toBe(201);
      expect(done.body.account.phoneNumberId).toBe(w.phone);
      const T2 = await newTenant('NoPhoneMany'), w2 = ids();
      const r = await signup(T2, w2, { event: { type: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', wabaId: w2.waba }, extraPhones: [`PN-${uid()}`] });
      expect(r.done.status).toBe(400);
      expect(r.done.body.error.code).toBe('phone_selection_required');
      expect(await acct(T2.agencyId)).toBeNull();
    });
  });

  describe('idempotency and retries', () => {
    it('completing twice does not exchange the code or connect again', async () => {
      const T = await newTenant('Idem');
      const { st, done, w } = await signup(T);
      const again = await T.admin.post(`${base}/complete`, { attemptId: st.body.attemptId, state: st.body.state, code: w.code, event: finish(w), displayName: 'Golden Travels' });
      expect(again.status).toBe(201);
      expect(again.body).toMatchObject({ status: 'completed', alreadyCompleted: true });
      expect(fake.exchanged.filter((c) => c === w.code)).toHaveLength(1);
      expect(done.body.account.phoneNumberId).toBe(again.body.account.phoneNumberId);
      expect(await db.tenant(T.agencyId, (tx) => tx.whatsappAccount.count({ where: { agencyId: T.agencyId } }))).toBe(1);
    });

    it('two simultaneous completes yield exactly one exchange and one account', async () => {
      const T = await newTenant('Race'), w = ids();
      fake.codes.set(w.code, { wabaId: w.waba, phoneNumberId: w.phone });
      const st = await T.admin.post(`${base}/start`, {});
      const body = { attemptId: st.body.attemptId, state: st.body.state, code: w.code, event: finish(w), displayName: 'Golden Travels' };
      const rs = await Promise.all([T.admin.post(`${base}/complete`, body), T.admin.post(`${base}/complete`, body)]);
      expect(rs.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
      for (const r of rs) expect([201, 409]).toContain(r.status);
      expect(fake.exchanged.filter((c) => c === w.code)).toHaveLength(1);
      expect(await db.tenant(T.agencyId, (tx) => tx.whatsappAccount.count({ where: { agencyId: T.agencyId } }))).toBe(1);
    });

    it('start is idempotent: it reuses the open attempt and rotates the state value', async () => {
      const T = await newTenant('StartTwice');
      const a = await T.admin.post(`${base}/start`, {}), b = await T.admin.post(`${base}/start`, {});
      expect(b.body.attemptId).toBe(a.body.attemptId);
      expect(b.body.state).not.toBe(a.body.state);
      // The older state value no longer works.
      const w = ids(); fake.codes.set(w.code, { wabaId: w.waba, phoneNumberId: w.phone });
      const old = await T.admin.post(`${base}/complete`, { attemptId: a.body.attemptId, state: a.body.state, code: w.code, event: finish(w), displayName: 'Golden Travels' });
      expect(old.status).toBe(403);
      expect(old.body.error.code).toBe('signup_state_invalid');
      expect(fake.exchanged).not.toContain(w.code);
    });

    it('resumes after a partial failure from the stored token, without a new code', async () => {
      const T = await newTenant('Resume'), w = ids();
      fake.subscribeError = new WaSendError('(#200) Requires whatsapp_business_management permission', '200', false, 'auth');
      const first = await signup(T, w);
      expect(first.done.status).toBe(400);
      expect(first.done.body.error).toMatchObject({ retryable: true });
      expect(await acct(T.agencyId)).toBeNull(); // nothing half-connected
      const mid = await attemptRow(T.agencyId, first.st.body.attemptId);
      expect(mid.status).toBe('failed');
      expect(mid.failedStep).toBe('subscribe');
      expect(mid.tokenRef).toBeTruthy(); // kept, encrypted, so the retry needs no new code
      expect(mid.tokenRef).not.toContain('EAAG');
      fake.subscribeError = undefined;
      const st = await T.admin.post(`${base}/start`, {}); // new state, same attempt
      expect(st.body.attemptId).toBe(first.st.body.attemptId);
      const retry = await T.admin.post(`${base}/complete`, { attemptId: st.body.attemptId, state: st.body.state, event: finish(w), displayName: 'Golden Travels' }); // no code
      expect(retry.status).toBe(201);
      expect(retry.body.account.connected).toBe(true);
      expect(fake.exchanged.filter((c) => c === w.code)).toHaveLength(1);
    });

    it('a failed exchange stores nothing, and the same code can never be retried', async () => {
      const T = await newTenant('BadCode'), w = ids();
      const first = await signup(T, w, { fakeFor: false }); // Meta does not know this code
      expect(first.done.status).toBe(400);
      expect(first.done.body.error).toMatchObject({ code: 'code_required', needsNewCode: true });
      expect(await acct(T.agencyId)).toBeNull();
      expect((await attemptRow(T.agencyId, first.st.body.attemptId)).tokenRef).toBeNull();
      // Same (now "used") code again: refused locally, Meta is not asked a second time.
      const before = fake.attempted.filter((x) => x === 'exchange').length;
      const st = await T.admin.post(`${base}/start`, {});
      const again = await T.admin.post(`${base}/complete`, { attemptId: st.body.attemptId, state: st.body.state, code: w.code, event: finish(w), displayName: 'Golden Travels' });
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe('code_required');
      expect(fake.attempted.filter((x) => x === 'exchange').length).toBe(before);
      // A fresh code works on the same attempt.
      const w2 = { ...w, code: `code-${uid()}` }; fake.codes.set(w2.code, { wabaId: w.waba, phoneNumberId: w.phone });
      const ok = await T.admin.post(`${base}/complete`, { attemptId: st.body.attemptId, state: st.body.state, code: w2.code, event: finish(w), displayName: 'Golden Travels' });
      expect(ok.status).toBe(201);
    });

    it('a code cannot be replayed from another attempt', async () => {
      const A = await newTenant('ReplayA'), B = await newTenant('ReplayB'), w = ids();
      const ok = await signup(A, w);
      expect(ok.done.status).toBe(201);
      const exchanges = fake.attempted.filter((x) => x === 'exchange').length;
      const st = await B.admin.post(`${base}/start`, {});
      const r = await B.admin.post(`${base}/complete`, { attemptId: st.body.attemptId, state: st.body.state, code: w.code, event: finish(w), displayName: 'Thief' });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('code_already_used'); // refused locally by the code's hash: Meta is not even asked
      expect(fake.attempted.filter((x) => x === 'exchange').length).toBe(exchanges);
      expect(await acct(B.agencyId)).toBeNull();
      expect((await acct(A.agencyId))?.wabaId).toBe(w.waba);
    });

    it('an expired attempt is closed and its token forgotten', async () => {
      const T = await newTenant('Expire'), w = ids();
      fake.subscribeError = new WaSendError('boom', '1', true, 'transient');
      const first = await signup(T, w);
      fake.subscribeError = undefined;
      await db.tenant(T.agencyId, (tx) => tx.whatsappSignupAttempt.update({ where: { id: first.st.body.attemptId }, data: { expiresAt: new Date(Date.now() - 1000) } }));
      const st = await T.admin.post(`${base}/start`, {});
      expect(st.body.attemptId).not.toBe(first.st.body.attemptId); // a new attempt, the old one is expired
      const old = await attemptRow(T.agencyId, first.st.body.attemptId);
      expect(old).toMatchObject({ status: 'expired', tokenRef: null });
    });
  });

  describe('state, ownership and tenant isolation', () => {
    it('rejects a wrong state value', async () => {
      const T = await newTenant('BadState'), w = ids(); fake.codes.set(w.code, { wabaId: w.waba, phoneNumberId: w.phone });
      const st = await T.admin.post(`${base}/start`, {});
      const r = await T.admin.post(`${base}/complete`, { attemptId: st.body.attemptId, state: 'x'.repeat(32), code: w.code, event: finish(w), displayName: 'Golden Travels' });
      expect(r.status).toBe(403);
      expect(fake.exchanged).not.toContain(w.code);
    });

    it("another agency cannot see, complete or cancel this agency's attempt", async () => {
      const A = await newTenant('IsoA'), B = await newTenant('IsoB'), w = ids(); fake.codes.set(w.code, { wabaId: w.waba, phoneNumberId: w.phone });
      const st = await A.admin.post(`${base}/start`, {});
      const done = await B.admin.post(`${base}/complete`, { attemptId: st.body.attemptId, state: st.body.state, code: w.code, event: finish(w), displayName: 'Golden Travels' });
      expect(done.status).toBe(404);
      expect((await B.admin.post(`${base}/cancel`, { attemptId: st.body.attemptId })).body).toEqual({ ok: false });
      expect((await B.admin.get(base)).body.attempt).toBeNull();
      expect(fake.exchanged).not.toContain(w.code);
      expect((await attemptRow(A.agencyId, st.body.attemptId)).status).toBe('started');
    });

    it('rejects a phone number that does not belong to the reported business account', async () => {
      const T = await newTenant('Mismatch'), w = ids();
      const { done } = await signup(T, w, { event: finish(w, { phoneNumberId: `PN-${uid()}` }) });
      expect(done.status).toBe(400);
      expect(done.body.error.code).toBe('asset_mismatch');
      expect(done.body.error.retryable).toBe(false);
      expect(await acct(T.agencyId)).toBeNull();
    });

    it("rejects claiming someone else's business account (the token has no access to it)", async () => {
      const T = await newTenant('Claim'), w = ids();
      const { done } = await signup(T, w, { event: finish(w, { wabaId: `WABA-${uid()}` }) });
      expect(done.status).toBe(400);
      expect(await acct(T.agencyId)).toBeNull();
    });

    it('does not let one number or business account be linked to two agencies', async () => {
      const A = await newTenant('ClashA'), B = await newTenant('ClashB'), w = ids();
      expect((await signup(A, w)).done.status).toBe(201);
      const w2 = { waba: w.waba, phone: `PN-${uid()}`, code: `code-${uid()}` }; // same WABA
      const r1 = await signup(B, w2);
      expect(r1.done.status).toBe(409);
      expect(r1.done.body.error.code).toBe('whatsapp_in_use');
      const w3 = { waba: `WABA-${uid()}`, phone: w.phone, code: `code-${uid()}` }; // same number
      const B2 = await newTenant('ClashB2');
      expect((await signup(B2, w3)).done.status).toBe(409);
      expect(await acct(B.agencyId)).toBeNull();
      expect((await acct(A.agencyId))?.connectionStatus).toBe('connected');
    });

    it('refuses numbers that are not WhatsApp Business app (coexistence) numbers, and never registers anything', async () => {
      const T = await newTenant('NotCoex');
      const { done } = await signup(T, ids(), { isOnBizApp: false });
      expect(done.status).toBe(400);
      expect(done.body.error.code).toBe('not_coexistence');
      expect(await acct(T.agencyId)).toBeNull();
      expect(fake.attempted.some((x) => /regist/i.test(x))).toBe(false);
    });

    it('ignores events that are not a completed sign-up (cancelled, errors, WABA-only)', async () => {
      for (const type of ['CANCEL', 'ERROR', 'FINISH_ONLY_WABA']) {
        const T = await newTenant('Evt'), w = ids();
        const { done } = await signup(T, w, { event: { type, wabaId: w.waba } });
        expect(done.status).toBe(400);
        expect(done.body.error.code).toBe('invalid_event');
        expect(fake.exchanged).not.toContain(w.code);
      }
    });

    it('can be cancelled, which forgets any stored token', async () => {
      const T = await newTenant('Cancel'), w = ids();
      fake.subscribeError = new WaSendError('boom', '1', true, 'transient');
      const first = await signup(T, w);
      fake.subscribeError = undefined;
      expect((await T.admin.post(`${base}/cancel`, { attemptId: first.st.body.attemptId })).body).toEqual({ ok: true });
      expect(await attemptRow(T.agencyId, first.st.body.attemptId)).toMatchObject({ status: 'cancelled', tokenRef: null });
    });
  });

  describe('connection preservation (no overwrite)', () => {
    it('refuses to start while a connection is live, and leaves it untouched', async () => {
      const T = await newTenant('Keep'), w = ids();
      expect((await signup(T, w)).done.status).toBe(201);
      const before = await acct(T.agencyId);
      const r = await T.admin.post(`${base}/start`, {});
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('whatsapp_already_connected');
      expect((await T.admin.get(base)).body.blockedByExistingConnection).toBe(true);
      const after = await acct(T.agencyId);
      expect(after?.credentialSecretRef).toBe(before?.credentialSecretRef);
      expect(after?.phoneNumberId).toBe(before?.phoneNumberId);
      expect(after?.connectionStatus).toBe('connected');
    });

    it('a manually connected account is never replaced, even if it appears after the sign-up started', async () => {
      const T = await newTenant('Manual'), w = ids(); fake.codes.set(w.code, { wabaId: w.waba, phoneNumberId: w.phone });
      const st = await T.admin.post(`${base}/start`, {});
      // The admin connects manually while the Meta window is open.
      const manual = { displayName: 'Manual line', wabaId: `WABA-${uid()}`, phoneNumberId: `PN-${uid()}`, accessToken: 'EAAG-manual-token-value' };
      expect((await T.admin.post('/agency/whatsapp/connect', manual)).status).toBe(201);
      const before = await acct(T.agencyId);
      const r = await T.admin.post(`${base}/complete`, { attemptId: st.body.attemptId, state: st.body.state, code: w.code, event: finish(w), displayName: 'Golden Travels' });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('whatsapp_already_connected');
      const after = await acct(T.agencyId);
      expect(after?.credentialSecretRef).toBe(before?.credentialSecretRef);
      expect(decryptSecret(after!.credentialSecretRef!)).toBe('EAAG-manual-token-value');
      expect(after).toMatchObject({ phoneNumberId: manual.phoneNumberId, wabaId: manual.wabaId, onboardingMethod: 'manual', isCoexistence: false });
      expect((await attemptRow(T.agencyId, st.body.attemptId))).toMatchObject({ status: 'failed_permanent', tokenRef: null }); // the unused token is dropped
    });

    it('may reuse the row of a previously disconnected account, and manual connect still works as a fallback', async () => {
      const T = await newTenant('Reconnect'), w = ids();
      expect((await signup(T, w)).done.status).toBe(201);
      expect((await T.admin.post('/agency/whatsapp/disconnect')).status).toBe(201);
      const w2 = ids();
      const again = await signup(T, w2);
      expect(again.done.status).toBe(201);
      expect(again.done.body.account.phoneNumberId).toBe(w2.phone);
      expect(await db.tenant(T.agencyId, (tx) => tx.whatsappAccount.count({ where: { agencyId: T.agencyId } }))).toBe(1);
      // manual fallback still replaces/updates as before
      const manual = await T.admin.post('/agency/whatsapp/connect', { displayName: 'Manual line', wabaId: `WABA-${uid()}`, phoneNumberId: `PN-${uid()}`, accessToken: 'EAAG-manual-token-value' });
      expect(manual.status).toBe(201);
      expect(manual.body).toMatchObject({ mode: 'cloud', connected: true });
    });
  });
});
