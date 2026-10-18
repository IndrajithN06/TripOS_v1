import { ConflictException, Logger } from '@nestjs/common';
import { encryptSecret, sha256 } from '../../common/crypto';
import { resetConfigForTests } from '../../config/config';
import { WaSendError } from '../../providers/whatsapp/whatsapp';
import { FakeDb } from '../../../test/fake-db';
import { EmbeddedSignupService } from './embedded-signup.service';

// Token lifecycle of sign-up attempts: a token is held (encrypted) only between exchange and commit, never beyond the attempt's
// ORIGINAL deadline, and abandoned attempts are cleaned up. In-memory DB, throwaway secrets. Tenant isolation by row-level security
// is a database feature and is covered by the e2e suites; here we check the logic never crosses agencies.
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

const MIN = 60 * 1000;
const STATE = 'state-value-0123456789abcdef';
const attempt = (over: Record<string, any> = {}) => ({
  id: 'att-1', agencyId: 'agency-1', userId: 'user-1', stateHash: sha256(STATE), status: 'failed', step: 'subscribe', codeHash: 'ch', tokenRef: encryptSecret('business-token'),
  wabaId: 'W1', phoneNumberId: 'PN1', businessId: 'B1', signupAppId: 'APP_SIGNUP', requestSync: false, syncStatus: null, failedStep: 'subscribe',
  lastErrorCode: 'whatsapp_error', lastError: 'temporary', runStartedAt: null, expiresAt: new Date(Date.now() + 10 * MIN), completedAt: null, ...over,
});
function make(rows: any[]) {
  const db = new FakeDb({ whatsappSignupAttempt: rows });
  const wa: any = {
    name: 'cloud', simulated: false,
    exchangeSignupCode: jest.fn(async () => ({ accessToken: 'business-token' })), listWabaPhoneNumbers: jest.fn(async () => [{ id: 'PN1' }]),
    getCoexistenceInfo: jest.fn(async () => ({ isOnBizApp: true })), subscribeWebhooks: jest.fn(async () => undefined), getPhoneInfo: jest.fn(async () => ({})), requestSmbSync: jest.fn(async () => undefined),
  };
  return { db, wa, svc: new EmbeddedSignupService(db as any, wa, { syncTemplates: jest.fn(async () => ({})) } as any) };
}
const row = (db: FakeDb, id: string) => db.snapshot('whatsappSignupAttempt').find((r) => r.id === id)!;

describe('an attempt that holds a token never gets a longer life', () => {
  it('re-starting keeps the ORIGINAL deadline when a token is stored (but rotates the state value)', async () => {
    const original = new Date(Date.now() + 5 * MIN);
    const { db, svc } = make([attempt({ expiresAt: original })]);
    const before = row(db, 'att-1').stateHash;
    const r = await svc.start('agency-1', 'user-1', { requestSync: false });
    expect(r.attemptId).toBe('att-1');
    expect(row(db, 'att-1').expiresAt).toEqual(original); // not extended
    expect(row(db, 'att-1').stateHash).not.toBe(before);
    expect(new Date(r.expiresAt).getTime()).toBe(original.getTime()); // and the client is told the real deadline
  });
  it('an attempt WITHOUT a token still gets a fresh 30 minutes when re-started (nothing sensitive to retain)', async () => {
    const soon = new Date(Date.now() + 1 * MIN);
    const { db, svc } = make([attempt({ status: 'started', tokenRef: null, codeHash: null, signupAppId: null, expiresAt: soon })]);
    await svc.start('agency-1', 'user-1', { requestSync: false });
    expect(row(db, 'att-1').expiresAt.getTime()).toBeGreaterThan(Date.now() + 25 * MIN);
  });
  it('starting after the deadline closes the old attempt and forgets its token, then opens a new one', async () => {
    const { db, svc } = make([attempt({ expiresAt: new Date(Date.now() - MIN) })]);
    const r = await svc.start('agency-1', 'user-1', { requestSync: false });
    expect(r.attemptId).not.toBe('att-1');
    expect(row(db, 'att-1')).toMatchObject({ status: 'expired', tokenRef: null });
  });
  it('a failed-then-retried run leaves the deadline alone', async () => {
    const original = new Date(Date.now() + 5 * MIN);
    const { db, wa, svc } = make([attempt({ status: 'started', tokenRef: null, codeHash: null, signupAppId: null, step: 'start', failedStep: null, lastError: null, lastErrorCode: null, expiresAt: original })]);
    wa.subscribeWebhooks.mockRejectedValueOnce(new WaSendError('temporary', '1', true, 'transient'));
    const input = { attemptId: 'att-1', state: STATE, code: 'code-1', displayName: 'Line', event: { type: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', wabaId: 'W1', phoneNumberId: 'PN1' } };
    await expect(svc.complete('agency-1', 'user-1', input)).rejects.toBeDefined();
    expect(row(db, 'att-1')).toMatchObject({ status: 'failed', expiresAt: original });
    expect(row(db, 'att-1').tokenRef).toBeTruthy(); // retained for the retry, within the original deadline
    await svc.complete('agency-1', 'user-1', { ...input, code: undefined });
    expect(row(db, 'att-1')).toMatchObject({ status: 'completed', tokenRef: null });
    expect(row(db, 'att-1').expiresAt).toEqual(original);
  });
});

describe('sweeping expired attempts', () => {
  const rows = () => [
    attempt({ id: 'expired-failed', agencyId: 'agency-1', status: 'failed', expiresAt: new Date(Date.now() - MIN) }),
    attempt({ id: 'expired-started', agencyId: 'agency-2', status: 'started', expiresAt: new Date(Date.now() - 5 * MIN) }),
    attempt({ id: 'expired-stale-running', agencyId: 'agency-2', status: 'running', runStartedAt: new Date(Date.now() - 20 * MIN), expiresAt: new Date(Date.now() - MIN) }),
    attempt({ id: 'live-failed', agencyId: 'agency-1', status: 'failed', expiresAt: new Date(Date.now() + 10 * MIN) }),
    attempt({ id: 'live-running', agencyId: 'agency-3', status: 'running', runStartedAt: new Date(), expiresAt: new Date(Date.now() + 10 * MIN) }),
    attempt({ id: 'leftover-completed', agencyId: 'agency-1', status: 'completed', completedAt: new Date(), expiresAt: new Date(Date.now() - MIN) }),
    attempt({ id: 'leftover-cancelled', agencyId: 'agency-3', status: 'cancelled' }),
    attempt({ id: 'leftover-permanent', agencyId: 'agency-3', status: 'failed_permanent' }),
    attempt({ id: 'already-clean', agencyId: 'agency-3', status: 'expired', tokenRef: null }),
  ];

  it('closes and forgets the token of every expired, unfinished attempt, across agencies', async () => {
    const { db, svc } = make(rows());
    const r = await svc.sweepExpiredAttempts();
    expect(r.expired).toBe(3);
    for (const id of ['expired-failed', 'expired-started', 'expired-stale-running']) expect(row(db, id)).toMatchObject({ status: 'expired', tokenRef: null, runStartedAt: null });
  });
  it('leaves attempts still inside their deadline untouched, including one that is mid-run', async () => {
    const { db, svc } = make(rows());
    const before = { failed: row(db, 'live-failed'), running: row(db, 'live-running') };
    await svc.sweepExpiredAttempts();
    expect(row(db, 'live-failed')).toEqual(before.failed);
    expect(row(db, 'live-running')).toEqual(before.running);
    expect(row(db, 'live-failed').tokenRef).toBeTruthy();
  });
  it('clears a leftover token from any finished or closed attempt without changing its status', async () => {
    const { db, svc } = make(rows());
    const r = await svc.sweepExpiredAttempts();
    expect(r.leftovers).toBeGreaterThanOrEqual(3);
    expect(row(db, 'leftover-completed')).toMatchObject({ status: 'completed', tokenRef: null });
    expect(row(db, 'leftover-cancelled')).toMatchObject({ status: 'cancelled', tokenRef: null });
    expect(row(db, 'leftover-permanent')).toMatchObject({ status: 'failed_permanent', tokenRef: null });
  });
  it('touches nothing but status/token/run lock: ownership and progress columns are intact for every row (no cross-tenant effect)', async () => {
    const { db, svc } = make(rows());
    const before = db.snapshot('whatsappSignupAttempt');
    await svc.sweepExpiredAttempts();
    for (const b of before) {
      const after = row(db, b.id);
      for (const col of ['agencyId', 'userId', 'stateHash', 'codeHash', 'wabaId', 'phoneNumberId', 'businessId', 'signupAppId', 'expiresAt', 'lastError']) expect(after[col]).toEqual(b[col]);
    }
  });
  it('is idempotent: a second run changes nothing', async () => {
    const { db, svc } = make(rows());
    await svc.sweepExpiredAttempts();
    const changed = db.rowsChanged;
    expect(await svc.sweepExpiredAttempts()).toEqual({ expired: 0, leftovers: 0 });
    expect(db.rowsChanged).toBe(changed);
  });
  it('an attempt swept while it waited can no longer be resumed: it fails closed and never touches Meta', async () => {
    const { db, wa, svc } = make(rows());
    await svc.sweepExpiredAttempts();
    const err = await svc.complete('agency-1', 'user-1', { attemptId: 'expired-failed', state: STATE, displayName: 'Line', event: { type: 'FINISH', wabaId: 'W1', phoneNumberId: 'PN1' } }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'signup_closed' });
    expect(wa.exchangeSignupCode).not.toHaveBeenCalled();
    expect(wa.listWabaPhoneNumbers).not.toHaveBeenCalled();
    expect(db.snapshot('whatsappAccount')).toHaveLength(0);
  });
  it('the safe wrapper reports a database problem instead of throwing (e.g. migration missing)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { db, svc } = make([]);
    db.system = (async () => { throw new Error('relation does not exist'); }) as any;
    expect(await svc.sweepExpiredAttemptsSafely()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
