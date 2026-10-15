import { ConflictException, Logger } from '@nestjs/common';
import { decryptSecret, encryptSecret } from '../../common/crypto';
import { resetConfigForTests } from '../../config/config';
import { WaSendError } from '../../providers/whatsapp/whatsapp';
import { FakeDb } from '../../../test/fake-db';
import { WhatsappAccountService } from './whatsapp-account.service';

// DB-free: an in-memory Db and a stub provider. Throwaway secrets only. These prove the service logic; RLS and migrations are
// covered (when run) by the e2e suites against a migrated database.
const ENV = {
  DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789', WHATSAPP_PROVIDER: 'cloud',
  WHATSAPP_APP_ID: 'APP_PRIMARY', WHATSAPP_APP_SECRET: 'secret-primary', WHATSAPP_VERIFY_TOKEN: 'verify-primary',
  WHATSAPP_SIGNUP_APP_ID: 'APP_SIGNUP', WHATSAPP_SIGNUP_APP_SECRET: 'secret-signup', WHATSAPP_SIGNUP_VERIFY_TOKEN: 'verify-signup',
};
const KEYS = Object.keys(ENV);
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; });
beforeEach(() => { Object.assign(process.env, ENV); resetConfigForTests(); });
afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetConfigForTests(); });

const AG = 'agency-1';
const account = (over: Record<string, any> = {}) => ({
  id: 'acc-1', agencyId: AG, mode: 'cloud', wabaId: 'WABA-OLD', phoneNumberId: 'PN-OLD', displayName: 'Old line', credentialSecretRef: encryptSecret('old-token'),
  connectionStatus: 'connected', statusReason: null, webhookSubscribed: true, lastErrorCode: null, lastErrorAt: null, lastCheckedAt: null,
  onboardingMethod: 'manual', isCoexistence: false, businessId: null, connectedByUserId: null, metaAppId: null, ...over,
});
const embedded = (over: Record<string, any> = {}) => account({ onboardingMethod: 'embedded', isCoexistence: true, businessId: 'BIZ', connectedByUserId: 'user-1', metaAppId: 'APP_SIGNUP', ...over });

function make(rows: any[], name: 'cloud' | 'simulator' = 'cloud') {
  const db = new FakeDb({ whatsappAccount: rows });
  const wa: any = {
    name, simulated: name === 'simulator',
    getPhoneInfo: jest.fn(async () => ({ displayPhoneNumber: '+91 98000 00000', verifiedName: 'Line', displayNameStatus: 'APPROVED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K', status: 'CONNECTED' })),
    subscribeWebhooks: jest.fn(async () => undefined),
    listTemplates: jest.fn(async () => []),
  };
  return { db, wa, svc: new WhatsappAccountService(db as any, wa) };
}
const input = { displayName: 'Manual line', wabaId: 'WABA-NEW', phoneNumberId: 'PN-NEW', accessToken: 'new-token-value-123' };

describe('manual connect never replaces an active Embedded Signup connection (H1)', () => {
  it.each(['connected', 'degraded', 'connecting'])('refuses with 409 while the Embedded Signup account is %s, before any Meta call, and changes nothing', async (status) => {
    const { db, wa, svc } = make([embedded({ connectionStatus: status })]);
    const before = db.snapshot('whatsappAccount');
    const err = await svc.connect(AG, 'admin-1', input).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'embedded_account_active' });
    expect(wa.getPhoneInfo).not.toHaveBeenCalled();
    expect(wa.subscribeWebhooks).not.toHaveBeenCalled();
    expect(db.snapshot('whatsappAccount')).toEqual(before); // credential, app id, coexistence flag, business id: all untouched
    expect(db.ops.some((o) => /upsert|update|create/.test(o))).toBe(false);
  });

  it('also refuses in simulator mode', async () => {
    const { db, svc } = make([embedded()], 'simulator');
    const before = db.snapshot('whatsappAccount');
    await expect(svc.connect(AG, 'admin-1', { displayName: 'Sim line' })).rejects.toBeInstanceOf(ConflictException);
    expect(db.snapshot('whatsappAccount')).toEqual(before);
  });

  it('catches an account that becomes active between the early check and the save (race), leaving it untouched', async () => {
    const row = account({ onboardingMethod: 'manual' });
    const { db, wa, svc } = make([row]);
    // While we talk to Meta, an Embedded Signup commit lands for the same agency.
    const landed = embedded();
    wa.getPhoneInfo.mockImplementationOnce(async () => { Object.assign(row, landed); return { status: 'CONNECTED' }; });
    const err = await svc.connect(AG, 'admin-1', input).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'embedded_account_active' });
    expect(db.snapshot('whatsappAccount')[0]).toMatchObject({ onboardingMethod: 'embedded', isCoexistence: true, metaAppId: 'APP_SIGNUP', credentialSecretRef: landed.credentialSecretRef });
  });

  it('a DISCONNECTED Embedded Signup row may be reused: its markers are reset and the new credential is attributed to no app', async () => {
    const { db, svc } = make([embedded({ connectionStatus: 'disconnected', credentialSecretRef: null })]);
    const acc = await svc.connect(AG, 'admin-1', input);
    expect(acc).toMatchObject({ mode: 'cloud', connectionStatus: 'connected', onboardingMethod: 'manual', isCoexistence: false, businessId: null, connectedByUserId: null, metaAppId: null, phoneNumberId: 'PN-NEW' });
    expect(decryptSecret(db.snapshot('whatsappAccount')[0].credentialSecretRef)).toBe('new-token-value-123');
  });

  it('manual connections behave exactly as before: connect, update and first-time create', async () => {
    const { db, wa, svc } = make([account()]);
    const updated = await svc.connect(AG, 'admin-1', input);
    expect(updated).toMatchObject({ onboardingMethod: 'manual', isCoexistence: false, metaAppId: null, phoneNumberId: 'PN-NEW' });
    expect(wa.getPhoneInfo).toHaveBeenCalledTimes(1);
    expect(wa.subscribeWebhooks).toHaveBeenCalledTimes(1);
    expect(db.snapshot('auditLog').map((a) => a.action)).toEqual(['whatsapp.connected']);

    const fresh = make([]);
    const created = await fresh.svc.connect(AG, 'admin-1', input);
    expect(created).toMatchObject({ onboardingMethod: 'manual', metaAppId: null, connectionStatus: 'connected' });
  });

  it('a failed Meta check still stores nothing (unchanged behaviour)', async () => {
    const { db, wa, svc } = make([account()]);
    wa.getPhoneInfo.mockRejectedValueOnce(new WaSendError('bad token', '190', false, 'auth'));
    const before = db.snapshot('whatsappAccount');
    await expect(svc.connect(AG, 'admin-1', input)).rejects.toBeDefined();
    expect(db.snapshot('whatsappAccount')).toEqual(before);
  });
});

describe('accounts tied to a Meta app that is not configured here (H2)', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => { errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined); });
  afterEach(() => { errorSpy.mockRestore(); jest.restoreAllMocks(); });

  it('flags the account degraded with a clear reason and logs at error level', async () => {
    const { db, svc } = make([embedded({ metaAppId: 'APP_OLD' })]);
    expect(await svc.flagUnrecognisedApp({ id: 'acc-1', agencyId: AG, metaAppId: 'APP_OLD' })).toBe(1);
    expect(db.snapshot('whatsappAccount')[0]).toMatchObject({ connectionStatus: 'degraded', lastErrorCode: 'APP_UNRECOGNISED' });
    expect(db.snapshot('whatsappAccount')[0].statusReason).toMatch(/not configured on this server/);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('APP_OLD'); // ids are not needed in the log line
  });

  it('does not repeat the write: a burst of events costs one database operation, and a later attempt matches nothing', async () => {
    const { db, svc } = make([embedded({ metaAppId: 'APP_OLD' })]);
    const a = { id: 'acc-1', agencyId: AG, metaAppId: 'APP_OLD' };
    await svc.flagUnrecognisedApp(a);
    const opsAfterFirst = db.ops.length, changedAfterFirst = db.rowsChanged;
    for (let i = 0; i < 50; i++) await svc.flagUnrecognisedApp(a);
    expect(db.ops.length).toBe(opsAfterFirst); // memoised: no further queries at all
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // After the memo expires the UPDATE is attempted once more but matches no row (already flagged), so nothing is rewritten.
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 11 * 60 * 1000);
    expect(await svc.flagUnrecognisedApp(a)).toBe(0);
    expect(db.rowsChanged).toBe(changedAfterFirst);
  });

  it('never touches a disconnected account', async () => {
    const { db, svc } = make([embedded({ metaAppId: 'APP_OLD', connectionStatus: 'disconnected' })]);
    expect(await svc.flagUnrecognisedApp({ id: 'acc-1', agencyId: AG, metaAppId: 'APP_OLD' })).toBe(0);
    expect(db.snapshot('whatsappAccount')[0].connectionStatus).toBe('disconnected');
  });

  it('the health check keeps such an account degraded instead of healing it while the configuration is still wrong', async () => {
    const { db, svc } = make([embedded({ metaAppId: 'APP_OLD' })]);
    const r: any = await svc.refreshHealth(AG);
    expect(r).toMatchObject({ connectionStatus: 'degraded', lastErrorCode: 'APP_UNRECOGNISED' });
    // Fixing the configuration (the account's app is configured again) lets the next check heal it.
    db.tables.whatsappAccount[0].metaAppId = 'APP_SIGNUP';
    const healed: any = await svc.refreshHealth(AG);
    expect(healed).toMatchObject({ connectionStatus: 'connected', lastErrorCode: null });
  });

  it('the startup audit flags only unrecognised apps; legacy NULL, primary and signup accounts are left alone', async () => {
    const rows = [
      account({ id: 'legacy', agencyId: 'a1', metaAppId: null }),
      account({ id: 'primary', agencyId: 'a2', metaAppId: 'APP_PRIMARY' }),
      embedded({ id: 'signup', agencyId: 'a3' }),
      embedded({ id: 'rotated', agencyId: 'a4', metaAppId: 'APP_ROTATED_AWAY' }),
      embedded({ id: 'gone', agencyId: 'a5', metaAppId: 'APP_ROTATED_AWAY', connectionStatus: 'disconnected' }),
    ];
    const { db, svc } = make(rows);
    expect(await svc.auditAppIdentities()).toEqual({ checked: 4, unrecognised: 2 }); // NULL rows are not even read
    const status = Object.fromEntries(db.snapshot('whatsappAccount').map((r) => [r.id, r.connectionStatus]));
    expect(status).toEqual({ legacy: 'connected', primary: 'connected', signup: 'connected', rotated: 'degraded', gone: 'disconnected' });
  });

  it('the safe audit reports a missing migration instead of crashing startup', async () => {
    const { db, svc } = make([]);
    db.system = (async () => { throw new Error('column "metaAppId" does not exist'); }) as any;
    expect(await svc.auditAppIdentitiesSafely()).toBeNull();
    expect(JSON.stringify(errorSpy.mock.calls)).toMatch(/migration/);
  });
});
