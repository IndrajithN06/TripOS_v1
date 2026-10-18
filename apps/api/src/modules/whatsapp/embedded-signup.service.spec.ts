import { ConflictException } from '@nestjs/common';
import { decryptSecret, encryptSecret, sha256 } from '../../common/crypto';
import { resetConfigForTests } from '../../config/config';
import { accountAppKey } from '../../providers/whatsapp/app-identity';
import { metaApps } from '../../providers/whatsapp/meta-apps';
import { WaSendError } from '../../providers/whatsapp/whatsapp';
import { FakeDb } from '../../../test/fake-db';
import { EmbeddedSignupService } from './embedded-signup.service';

// DB-free (in-memory Db, stub Meta). Throwaway secrets. Exercises the real service logic through the public complete() entry point.
const ENV = {
  DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789', WHATSAPP_PROVIDER: 'cloud',
  WHATSAPP_APP_ID: 'APP_PRIMARY', WHATSAPP_APP_SECRET: 'secret-primary', WHATSAPP_VERIFY_TOKEN: 'verify-primary',
  WHATSAPP_SIGNUP_APP_ID: 'APP_SIGNUP', WHATSAPP_SIGNUP_APP_SECRET: 'secret-signup', WHATSAPP_SIGNUP_VERIFY_TOKEN: 'verify-signup',
  WHATSAPP_EMBEDDED_SIGNUP_ENABLED: 'true', WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: 'CFG',
};
const KEYS = Object.keys(ENV);
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; });
beforeEach(() => { Object.assign(process.env, ENV); resetConfigForTests(); });
afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetConfigForTests(); });

const AG = 'agency-1', USER = 'user-1', STATE = 'state-value-0123456789abcdef';
const rotateSignupApp = () => { process.env.WHATSAPP_SIGNUP_APP_ID = 'APP_SIGNUP_2'; process.env.WHATSAPP_SIGNUP_APP_SECRET = 'secret-signup-2'; resetConfigForTests(); };

const attempt = (over: Record<string, any> = {}) => ({
  id: 'att-1', agencyId: AG, userId: USER, stateHash: sha256(STATE), status: 'started', step: 'start', codeHash: null, tokenRef: null, wabaId: null, phoneNumberId: null,
  businessId: null, signupAppId: null, requestSync: false, syncStatus: null, failedStep: null, lastErrorCode: null, lastError: null, runStartedAt: null,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000), completedAt: null, ...over,
});
function make(rows: { attempts?: any[]; accounts?: any[] } = {}) {
  const db = new FakeDb({ whatsappSignupAttempt: rows.attempts ?? [attempt()], whatsappAccount: rows.accounts ?? [] });
  const wa: any = {
    name: 'cloud', simulated: false,
    exchangeSignupCode: jest.fn(async () => ({ accessToken: 'business-token' })),
    listWabaPhoneNumbers: jest.fn(async () => [{ id: 'PN1' }]),
    getCoexistenceInfo: jest.fn(async () => ({ isOnBizApp: true })),
    subscribeWebhooks: jest.fn(async () => undefined),
    getPhoneInfo: jest.fn(async () => ({ displayPhoneNumber: '+91 98000 00000', verifiedName: 'Golden Travels', displayNameStatus: 'APPROVED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K' })),
    requestSmbSync: jest.fn(async () => undefined),
  };
  const accounts: any = { syncTemplates: jest.fn(async () => ({})) };
  return { db, wa, svc: new EmbeddedSignupService(db as any, wa, accounts) };
}
const body = (over: Record<string, any> = {}) => ({
  attemptId: 'att-1', state: STATE, code: 'code-1', displayName: 'Golden Travels',
  event: { type: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', wabaId: 'W1', phoneNumberId: 'PN1', businessId: 'BIZ-1' }, ...over,
});
const failure = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return { status: e.getStatus?.(), ...(e.getResponse?.() ?? {}) }; } throw new Error('expected the call to fail'); };

describe('the signup app id is recorded with the token and checked before commit (M3)', () => {
  it('records the app id when the token is exchanged, and the committed account carries exactly that app id', async () => {
    const { db, wa, svc } = make();
    const r = await svc.complete(AG, USER, body());
    expect(r.status).toBe('completed');
    expect(db.snapshot('whatsappSignupAttempt')[0]).toMatchObject({ status: 'completed', signupAppId: 'APP_SIGNUP', tokenRef: null });
    const acc = db.snapshot('whatsappAccount')[0];
    expect(acc).toMatchObject({ onboardingMethod: 'embedded', isCoexistence: true, metaAppId: 'APP_SIGNUP', wabaId: 'W1', phoneNumberId: 'PN1' });
    expect(decryptSecret(acc.credentialSecretRef)).toBe('business-token');
    expect(wa.subscribeWebhooks.mock.calls[0][0]).toMatchObject({ appId: 'APP_SIGNUP' }); // app-specific calls use the recorded app
    expect(accountAppKey(acc.metaAppId, metaApps())).toBe('signup'); // and the account lands on the signup webhook route
  });

  it('if the signup app changes between the exchange and a resume, the old token is NOT committed under the new app', async () => {
    const { db, wa, svc } = make();
    wa.subscribeWebhooks.mockRejectedValueOnce(new WaSendError('temporary', '1', true, 'transient'));
    const first = await failure(svc.complete(AG, USER, body()));
    expect(first).toMatchObject({ code: 'whatsapp_error', retryable: true });
    expect(db.snapshot('whatsappSignupAttempt')[0]).toMatchObject({ status: 'failed', signupAppId: 'APP_SIGNUP' });
    expect(db.snapshot('whatsappSignupAttempt')[0].tokenRef).toBeTruthy();

    rotateSignupApp(); // the operator points the server at a different signup app
    const second = await failure(svc.complete(AG, USER, body({ code: undefined })));
    expect(second).toMatchObject({ code: 'signup_app_changed', retryable: false });
    expect(db.snapshot('whatsappAccount')).toHaveLength(0);
    expect(db.snapshot('whatsappSignupAttempt')[0]).toMatchObject({ status: 'failed_permanent', tokenRef: null }); // token dropped
    expect(wa.exchangeSignupCode).toHaveBeenCalledTimes(1);
    expect(wa.listWabaPhoneNumbers).toHaveBeenCalledTimes(1); // stopped before using the token again
  });

  it('re-checks right before committing: a configuration change during the run blocks the commit', async () => {
    const { db, wa, svc } = make();
    wa.subscribeWebhooks.mockImplementationOnce(async () => { rotateSignupApp(); });
    const err = await failure(svc.complete(AG, USER, body()));
    expect(err).toMatchObject({ code: 'signup_app_changed', retryable: false });
    expect(db.snapshot('whatsappAccount')).toHaveLength(0);
    expect(db.snapshot('whatsappSignupAttempt')[0]).toMatchObject({ status: 'failed_permanent', tokenRef: null });
    expect(db.snapshot('auditLog')).toHaveLength(0);
  });

  it('an attempt whose token predates this check (no app recorded) is refused rather than guessed', async () => {
    const legacy = attempt({ status: 'failed', step: 'verify', tokenRef: encryptSecret('legacy-token'), wabaId: 'W1', phoneNumberId: 'PN1', signupAppId: null });
    const { db, wa, svc } = make({ attempts: [legacy] });
    const err = await failure(svc.complete(AG, USER, body({ code: undefined })));
    expect(err).toMatchObject({ code: 'signup_app_changed' });
    expect(wa.exchangeSignupCode).not.toHaveBeenCalled();
    expect(wa.listWabaPhoneNumbers).not.toHaveBeenCalled();
    expect(db.snapshot('whatsappSignupAttempt')[0]).toMatchObject({ status: 'failed_permanent', tokenRef: null });
  });

  it('single-app setup (signup id = primary id, same secret): the account is recorded under that id and resolves to the PRIMARY route', async () => {
    process.env.WHATSAPP_SIGNUP_APP_ID = 'APP_PRIMARY'; process.env.WHATSAPP_SIGNUP_APP_SECRET = 'secret-primary'; resetConfigForTests();
    const { db, svc } = make();
    await svc.complete(AG, USER, body());
    const acc = db.snapshot('whatsappAccount')[0];
    expect(acc.metaAppId).toBe('APP_PRIMARY');
    expect(accountAppKey(acc.metaAppId, metaApps())).toBe('primary');
  });
});

describe('connection preservation still holds', () => {
  it('never overwrites an existing live connection, and drops the unused token', async () => {
    const existing = { id: 'acc-existing', agencyId: AG, mode: 'cloud', wabaId: 'W-OLD', phoneNumberId: 'PN-OLD', credentialSecretRef: encryptSecret('old-token'), connectionStatus: 'connected', onboardingMethod: 'manual', isCoexistence: false, metaAppId: null };
    const { db, svc } = make({ accounts: [existing] });
    const before = db.snapshot('whatsappAccount');
    const err = await failure(svc.complete(AG, USER, body()));
    expect(err).toMatchObject({ code: 'whatsapp_already_connected', status: 409 });
    expect(db.snapshot('whatsappAccount')).toEqual(before);
    expect(db.snapshot('whatsappSignupAttempt')[0]).toMatchObject({ status: 'failed_permanent', tokenRef: null });
    expect(db.snapshot('auditLog')).toHaveLength(0);
  });

  it('start() refuses while a connection is live, without creating an attempt', async () => {
    const existing = { id: 'acc-existing', agencyId: AG, connectionStatus: 'connected', onboardingMethod: 'embedded' };
    const { db, svc } = make({ attempts: [], accounts: [existing] });
    await expect(svc.start(AG, USER, { requestSync: false })).rejects.toBeInstanceOf(ConflictException);
    expect(db.snapshot('whatsappSignupAttempt')).toHaveLength(0);
  });
});

describe('discovery and eligibility failures, with a system-user token (mocked)', () => {
  const noPhone = body({ event: { type: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', wabaId: 'W1' } }); // coexistence event that carries only the WABA

  it('a WABA with NO phone numbers is refused clearly, nothing is subscribed, and the token is erased', async () => {
    const { db, wa, svc } = make();
    wa.listWabaPhoneNumbers.mockResolvedValueOnce([]);
    const err = await failure(svc.complete(AG, USER, noPhone));
    expect(err).toMatchObject({ code: 'phone_selection_required', retryable: false });
    expect(wa.subscribeWebhooks).not.toHaveBeenCalled();
    expect(wa.requestSmbSync).not.toHaveBeenCalled();
    expect(db.snapshot('whatsappAccount')).toHaveLength(0);
    expect(db.snapshot('whatsappSignupAttempt')[0]).toMatchObject({ status: 'failed_permanent', tokenRef: null });
  });

  it('a WABA with SEVERAL numbers is refused (choosing a number is not built), and none is guessed', async () => {
    const { db, wa, svc } = make();
    wa.listWabaPhoneNumbers.mockResolvedValueOnce([{ id: 'PN1' }, { id: 'PN2' }]);
    expect(await failure(svc.complete(AG, USER, noPhone))).toMatchObject({ code: 'phone_selection_required' });
    expect(db.snapshot('whatsappAccount')).toHaveLength(0);
  });

  it('a normal Cloud API number (not on the WhatsApp Business app) stops at the eligibility check: never registered, subscribed or synced, token erased', async () => {
    const { db, wa, svc } = make();
    wa.getCoexistenceInfo.mockResolvedValueOnce({ isOnBizApp: false, platformType: 'CLOUD_API' });
    const err = await failure(svc.complete(AG, USER, body({ event: { type: 'FINISH', wabaId: 'W1', phoneNumberId: 'PN1' } })));
    expect(err).toMatchObject({ code: 'not_coexistence', retryable: false });
    expect(wa.subscribeWebhooks).not.toHaveBeenCalled();
    expect(wa.requestSmbSync).not.toHaveBeenCalled();
    expect(Object.keys(wa).filter((k) => /regist|pin/i.test(k))).toEqual([]); // the provider has no way to register a number
    expect(db.snapshot('whatsappAccount')).toHaveLength(0);
    expect(db.snapshot('whatsappSignupAttempt')[0]).toMatchObject({ status: 'failed_permanent', tokenRef: null });
  });

  it('if the token\'s system user lacks access to the WABA, the failure is retryable: the token is kept and a resume (no new code) succeeds once access is fixed', async () => {
    const { db, wa, svc } = make();
    wa.listWabaPhoneNumbers.mockRejectedValueOnce(new WaSendError('(#200) Requires asset access', '200', false, 'auth'));
    const first = await failure(svc.complete(AG, USER, body()));
    expect(first).toMatchObject({ code: 'whatsapp_auth_failed', retryable: true });
    expect(first.message).toMatch(/Reconnect|permission|token/i);
    expect(db.snapshot('whatsappSignupAttempt')[0]).toMatchObject({ status: 'failed', failedStep: 'verify' });
    expect(db.snapshot('whatsappSignupAttempt')[0].tokenRef).toBeTruthy();
    expect(db.snapshot('whatsappAccount')).toHaveLength(0);

    const retry = await svc.complete(AG, USER, body({ code: undefined })); // access fixed on the Meta side; the same stored token is reused
    expect(retry.status).toBe('completed');
    expect(wa.exchangeSignupCode).toHaveBeenCalledTimes(1);
    expect(db.snapshot('whatsappAccount')[0]).toMatchObject({ onboardingMethod: 'embedded', isCoexistence: true, metaAppId: 'APP_SIGNUP' });
  });

  it('a permission failure on the eligibility check behaves the same way (retryable, token kept)', async () => {
    const { db, wa, svc } = make();
    wa.getCoexistenceInfo.mockRejectedValueOnce(new WaSendError('Application does not have permission', '10', false, 'auth'));
    expect(await failure(svc.complete(AG, USER, body()))).toMatchObject({ code: 'whatsapp_auth_failed', retryable: true });
    expect(db.snapshot('whatsappSignupAttempt')[0].tokenRef).toBeTruthy();
    expect(wa.subscribeWebhooks).not.toHaveBeenCalled();
  });

  it('the token is never present in any error body or stored message', async () => {
    const { db, wa, svc } = make();
    wa.subscribeWebhooks.mockRejectedValueOnce(new WaSendError('boom', '1', true, 'transient'));
    const err = await failure(svc.complete(AG, USER, body()));
    const stored = JSON.stringify(db.snapshot('whatsappSignupAttempt')[0].lastError);
    expect(JSON.stringify(err)).not.toContain('business-token');
    expect(stored).not.toContain('business-token');
  });
});
