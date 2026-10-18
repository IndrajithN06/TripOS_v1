import { Logger } from '@nestjs/common';
import { ForbiddenException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { resetConfigForTests } from '../../config/config';
import { useHermeticEnv } from '../../../test/hermetic-env';
import { CloudWhatsApp, parseCloudPayload } from '../../providers/whatsapp/whatsapp';
import { metaSignatureHeader } from '../../providers/whatsapp/signature';
import { InboundService, resetWebhookDiagnosticsForTests, SignupWebhooksController, WebhooksController } from './webhooks.module';

// No database, no network: the REAL provider verifies REAL HMAC signatures; only the inbound service / Db are stubbed.
// All secrets and tokens are throwaway strings for this test.
const ENV = {
  DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789', WHATSAPP_PROVIDER: 'cloud',
  WHATSAPP_APP_ID: 'APP_PRIMARY', WHATSAPP_APP_SECRET: 'secret-primary', WHATSAPP_VERIFY_TOKEN: 'verify-primary',
  WHATSAPP_SIGNUP_APP_ID: 'APP_SIGNUP', WHATSAPP_SIGNUP_APP_SECRET: 'secret-signup', WHATSAPP_SIGNUP_VERIFY_TOKEN: 'verify-signup',
};
useHermeticEnv(ENV);
// Individual tests drop the signup trio; start each one from the full two-app setup again.
beforeEach(() => { Object.assign(process.env, ENV); resetConfigForTests(); });

const payload = { object: 'whatsapp_business_account', entry: [{ id: 'WABA1', time: 1748477359, changes: [{ field: 'smb_message_echoes', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'PN1' }, message_echoes: [{ from: '1', to: '2', id: 'wamid.1', timestamp: '1748477000', type: 'text', text: { body: 'hi' } }] } }] }] };
const raw = Buffer.from(JSON.stringify(payload));
const req = (rawBody: Buffer = raw) => ({ rawBody, body: JSON.parse(rawBody.toString() || '{}') }) as any;
const stubInbound = () => ({ process: jest.fn(async (..._a: any[]) => ({ processed: 0, duplicates: 0, unknown: 0, ignored: 0, unrecognised: 0 })) });
const make = () => {
  const inbound = stubInbound(), wa = new CloudWhatsApp();
  return { inbound, primary: new WebhooksController(inbound as any, wa), signup: new SignupWebhooksController(inbound as any, wa) };
};
const sigA = (b = raw) => metaSignatureHeader(b, ENV.WHATSAPP_APP_SECRET);
const sigB = (b = raw) => metaSignatureHeader(b, ENV.WHATSAPP_SIGNUP_APP_SECRET);

describe('primary route /webhooks/whatsapp (existing Cloud API app)', () => {
  it('verifies with the primary verify token only', () => {
    const { primary } = make();
    expect(primary.verify('subscribe', 'verify-primary', 'CHALLENGE')).toBe('CHALLENGE');
    expect(() => primary.verify('subscribe', 'verify-signup', 'CHALLENGE')).toThrow(ForbiddenException); // the other app's token
    expect(() => primary.verify('subscribe', 'nope', 'CHALLENGE')).toThrow(ForbiddenException);
    expect(() => primary.verify('subscribe', '', 'CHALLENGE')).toThrow(ForbiddenException);
    expect(() => primary.verify('unsubscribe', 'verify-primary', 'CHALLENGE')).toThrow(ForbiddenException);
  });
  it('accepts a body signed with the primary secret and processes it as the primary app', async () => {
    const { primary, inbound } = make();
    await primary.receive(req(), sigA());
    expect(inbound.process).toHaveBeenCalledTimes(1);
    expect((inbound.process.mock.calls[0] as any[])[1]).toBe('primary');
  });
  it('rejects a body signed with the SIGNUP secret (cross-signed), unsigned, malformed and tampered requests', async () => {
    const { primary, inbound } = make();
    await expect(primary.receive(req(), sigB())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(primary.receive(req(), undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(primary.receive(req(), '')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(primary.receive(req(), 'sha256=abc')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(primary.receive(req(), sigA().replace('sha256=', ''))).rejects.toBeInstanceOf(UnauthorizedException);
    const tampered = Buffer.from(raw.toString().replace('hi', 'ho'));
    await expect(primary.receive(req(tampered), sigA(raw))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(inbound.process).not.toHaveBeenCalled();
  });
  it('is unaffected by the signup app being configured or not (backward compatible)', async () => {
    for (const k of ['WHATSAPP_SIGNUP_APP_ID', 'WHATSAPP_SIGNUP_APP_SECRET', 'WHATSAPP_SIGNUP_VERIFY_TOKEN']) delete process.env[k];
    resetConfigForTests();
    const { primary, inbound } = make();
    expect(primary.verify('subscribe', 'verify-primary', 'C')).toBe('C');
    await primary.receive(req(), sigA());
    expect(inbound.process).toHaveBeenCalledTimes(1);
    await expect(primary.receive(req(), sigB())).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('signup route /webhooks/whatsapp/signup (Embedded Signup app)', () => {
  it('verifies with the signup verify token only', () => {
    const { signup } = make();
    expect(signup.verify('subscribe', 'verify-signup', 'CHALLENGE')).toBe('CHALLENGE');
    expect(() => signup.verify('subscribe', 'verify-primary', 'CHALLENGE')).toThrow(ForbiddenException); // the other app's token
    expect(() => signup.verify('subscribe', 'nope', 'CHALLENGE')).toThrow(ForbiddenException);
    expect(() => signup.verify('subscribe', '', 'CHALLENGE')).toThrow(ForbiddenException);
  });
  it('accepts a body signed with the signup secret and processes it as the signup app', async () => {
    const { signup, inbound } = make();
    await signup.receive(req(), sigB());
    expect(inbound.process).toHaveBeenCalledTimes(1);
    expect((inbound.process.mock.calls[0] as any[])[1]).toBe('signup');
  });
  it('rejects a body signed with the PRIMARY secret (cross-signed), unsigned, malformed and tampered requests', async () => {
    const { signup, inbound } = make();
    await expect(signup.receive(req(), sigA())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(signup.receive(req(), undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(signup.receive(req(), 'sha256=not-hex')).rejects.toBeInstanceOf(UnauthorizedException);
    const tampered = Buffer.from(raw.toString().replace('hi', 'ho'));
    await expect(signup.receive(req(tampered), sigB(raw))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(inbound.process).not.toHaveBeenCalled();
  });
  it('does not exist (404) until the signup secret AND verify token are configured, and then never falls back to the primary app', async () => {
    delete process.env.WHATSAPP_SIGNUP_APP_SECRET; delete process.env.WHATSAPP_SIGNUP_VERIFY_TOKEN; delete process.env.WHATSAPP_SIGNUP_APP_ID;
    resetConfigForTests();
    const { signup, inbound } = make();
    expect(() => signup.verify('subscribe', 'verify-primary', 'C')).toThrow(NotFoundException);
    expect(() => signup.verify('subscribe', 'verify-signup', 'C')).toThrow(NotFoundException);
    await expect(signup.receive(req(), sigA())).rejects.toBeInstanceOf(NotFoundException); // a valid PRIMARY signature is not enough
    await expect(signup.receive(req(), sigB())).rejects.toBeInstanceOf(NotFoundException);
    expect(inbound.process).not.toHaveBeenCalled();
  });
  it('works when the onboarding feature flag is off (already-connected accounts keep receiving events)', async () => {
    process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED = 'false'; resetConfigForTests();
    const { signup, inbound } = make();
    await signup.receive(req(), sigB());
    expect(inbound.process).toHaveBeenCalledTimes(1);
    delete process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED;
  });
});

describe('InboundService: an event is applied only to an account issued by the app whose route authenticated it', () => {
  const account = (metaAppId: string | null, connectionStatus = 'connected', phoneNumberId = 'PN1') => ({ id: `acc-${phoneNumberId}`, agencyId: `ag-${phoneNumberId}`, phoneNumberId, wabaId: 'WABA1', connectionStatus, isCoexistence: true, credentialSecretRef: null, metaAppId });
  const build = (row: ReturnType<typeof account> | null | ReturnType<typeof account>[]) => {
    const rows = row === null ? [] : Array.isArray(row) ? row : [row];
    const tenant = jest.fn(async () => ({ processed: 1, duplicates: 0, ignored: 0 }));
    const find = async ({ where }: any) => rows.find((r) => !where?.phoneNumberId || r.phoneNumberId === where.phoneNumberId) ?? null;
    const db = { system: async (fn: any) => fn({ whatsappAccount: { findUnique: find, findFirst: find } }), tenant };
    const accounts = { touchWebhook: jest.fn(async () => undefined), flagUnrecognisedApp: jest.fn(async () => 0) };
    return { svc: new InboundService(db as any, {} as any, new CloudWhatsApp(), accounts as any), tenant, accounts };
  };
  const events = parseCloudPayload(payload);

  it('legacy account (NULL metaAppId = primary): processed on the primary route, ignored on the signup route', async () => {
    const a = build(account(null));
    expect(await a.svc.process(events, 'primary')).toMatchObject({ processed: 1, ignored: 0 });
    const b = build(account(null));
    expect(await b.svc.process(events, 'signup')).toMatchObject({ processed: 0, ignored: 1 });
    expect(b.tenant).not.toHaveBeenCalled();
    expect(b.accounts.touchWebhook).not.toHaveBeenCalled();
  });
  it('the default route is primary, so existing callers behave as before', async () => {
    const a = build(account(null));
    expect(await a.svc.process(events)).toMatchObject({ processed: 1 });
  });
  it('signup account: processed on the signup route, ignored on the primary route', async () => {
    const a = build(account('APP_SIGNUP'));
    expect(await a.svc.process(events, 'signup')).toMatchObject({ processed: 1, ignored: 0 });
    const b = build(account('APP_SIGNUP'));
    expect(await b.svc.process(events, 'primary')).toMatchObject({ processed: 0, ignored: 1 });
    expect(b.tenant).not.toHaveBeenCalled();
    expect(b.accounts.touchWebhook).not.toHaveBeenCalled();
  });
  it('an explicit primary app id behaves like NULL', async () => {
    const a = build(account('APP_PRIMARY'));
    expect(await a.svc.process(events, 'primary')).toMatchObject({ processed: 1 });
    const b = build(account('APP_PRIMARY'));
    expect(await b.svc.process(events, 'signup')).toMatchObject({ ignored: 1 });
  });
  it('an account tied to an unrecognised app is NOT silently dropped: it is flagged and reported (for a 503) on both routes', async () => {
    for (const route of ['primary', 'signup'] as const) {
      const a = build(account('SOME_OLD_APP'));
      expect(await a.svc.process(events, route)).toMatchObject({ processed: 0, ignored: 0, unrecognised: 1 });
      expect(a.accounts.flagUnrecognisedApp).toHaveBeenCalledTimes(1);
      expect(a.tenant).not.toHaveBeenCalled(); // nothing was applied
      expect(a.accounts.touchWebhook).not.toHaveBeenCalled();
    }
  });
  it('a DISCONNECTED account with an unrecognised app is simply ignored (nothing to recover, no 503)', async () => {
    const a = build(account('SOME_OLD_APP', 'disconnected'));
    expect(await a.svc.process(events, 'signup')).toMatchObject({ ignored: 1, unrecognised: 0 });
    expect(a.accounts.flagUnrecognisedApp).not.toHaveBeenCalled();
  });
  it('one unrecognised account does not stop the rest of the batch: the others are applied now and the batch is retried for the one', async () => {
    const two = parseCloudPayload({ entry: [
      { id: 'WABA1', time: 1, changes: [{ field: 'smb_message_echoes', value: { metadata: { phone_number_id: 'PN-BAD' }, message_echoes: [{ from: '1', to: '2', id: 'wamid.bad', timestamp: '1', type: 'text', text: { body: 'x' } }] } }] },
      { id: 'WABA2', time: 1, changes: [{ field: 'smb_message_echoes', value: { metadata: { phone_number_id: 'PN-OK' }, message_echoes: [{ from: '1', to: '3', id: 'wamid.ok', timestamp: '1', type: 'text', text: { body: 'y' } }] } }] },
    ] });
    const a = build([account('SOME_OLD_APP', 'connected', 'PN-BAD'), account(null, 'connected', 'PN-OK')]);
    expect(await a.svc.process(two, 'primary')).toMatchObject({ processed: 1, unrecognised: 1 });
    expect(a.tenant).toHaveBeenCalledTimes(1); // only the healthy account's event
  });
  it('an unknown number is reported as unknown on both routes and changes nothing', async () => {
    for (const route of ['primary', 'signup'] as const) {
      const a = build(null);
      expect(await a.svc.process(events, route)).toMatchObject({ processed: 0, unknown: 1 });
      expect(a.tenant).not.toHaveBeenCalled();
    }
  });
});

describe('HTTP outcome for events that cannot be applied', () => {
  it('answers 503 on BOTH routes when an event belongs to an unrecognised Meta app, so Meta retries it (it is not acknowledged)', async () => {
    const { primary, signup, inbound } = make();
    inbound.process.mockResolvedValue({ processed: 1, duplicates: 0, unknown: 0, ignored: 0, unrecognised: 2 });
    const e1 = await primary.receive(req(), sigA()).then(() => null, (e) => e);
    const e2 = await signup.receive(req(), sigB()).then(() => null, (e) => e);
    for (const e of [e1, e2]) {
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      expect(e.getStatus()).toBe(503);
      expect(e.getResponse()).toMatchObject({ code: 'app_unrecognised' });
    }
  });
  it('answers 200 when an event merely belongs to the OTHER app (ignored, not retried) or to an unknown/disconnected account', async () => {
    const { primary, signup, inbound } = make();
    inbound.process.mockResolvedValue({ processed: 0, duplicates: 0, unknown: 1, ignored: 3, unrecognised: 0 });
    await expect(primary.receive(req(), sigA())).resolves.toMatchObject({ ignored: 3 });
    await expect(signup.receive(req(), sigB())).resolves.toMatchObject({ unknown: 1 });
  });
  it('an invalid signature is still a 401 and never reaches the app check', async () => {
    const { primary, inbound } = make();
    await expect(primary.receive(req(), sigB())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(inbound.process).not.toHaveBeenCalled();
  });
});

describe('single-app mode: the signup route does not exist', () => {
  // Both app ids equal = one Meta app; every account resolves to the PRIMARY route, so the signup route would acknowledge and ignore
  // everything. It answers 404 instead, so a callback pointed there by mistake fails visibly.
  const singleApp = () => {
    process.env.WHATSAPP_SIGNUP_APP_ID = ENV.WHATSAPP_APP_ID; process.env.WHATSAPP_SIGNUP_APP_SECRET = ENV.WHATSAPP_APP_SECRET; resetConfigForTests();
  };
  it('returns 404 for the handshake and for a validly signed delivery, while the primary route works as before', async () => {
    singleApp();
    const { primary, signup, inbound } = make();
    expect(() => signup.verify('subscribe', 'verify-signup', 'C')).toThrow(NotFoundException);
    expect(() => signup.verify('subscribe', 'verify-primary', 'C')).toThrow(NotFoundException);
    await expect(signup.receive(req(), sigA())).rejects.toBeInstanceOf(NotFoundException); // signed with the (shared) secret, still 404
    expect(inbound.process).not.toHaveBeenCalled();
    expect(primary.verify('subscribe', 'verify-primary', 'OK')).toBe('OK');
    await primary.receive(req(), sigA());
    expect(inbound.process).toHaveBeenCalledTimes(1);
  });
  it('two different apps keep both routes (the 404 is only for equal ids)', async () => {
    const { signup, inbound } = make();
    await signup.receive(req(), sigB());
    expect(inbound.process).toHaveBeenCalledTimes(1);
  });
});

describe('alertable signal for unrecognised-app 503s', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => { resetWebhookDiagnosticsForTests(); errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined); });
  afterEach(() => errorSpy.mockRestore());
  const lines = () => errorSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('ALERT app_unrecognised_503'));

  it('every 503 logs one stable ALERT line with the route and event count; the 3rd in a row is marked REPEATED', async () => {
    const { primary, inbound } = make();
    inbound.process.mockResolvedValue({ processed: 0, duplicates: 0, unknown: 0, ignored: 0, unrecognised: 2 });
    for (let i = 0; i < 3; i++) await expect(primary.receive(req(), sigA())).rejects.toBeInstanceOf(ServiceUnavailableException);
    const l = lines();
    expect(l).toHaveLength(3);
    expect(l[0]).toMatch(/^ALERT app_unrecognised_503 route=primary events=2 consecutive=1 since=\d{4}-/);
    expect(l[0]).not.toMatch(/REPEATED/);
    expect(l[1]).toMatch(/consecutive=2/);
    expect(l[2]).toMatch(/consecutive=3 .*REPEATED$/);
  });
  it('a clean request resets the streak, and each route counts on its own', async () => {
    const { primary, signup, inbound } = make();
    inbound.process.mockResolvedValue({ processed: 0, duplicates: 0, unknown: 0, ignored: 0, unrecognised: 1 });
    await primary.receive(req(), sigA()).catch(() => undefined);
    await primary.receive(req(), sigA()).catch(() => undefined);
    await signup.receive(req(), sigB()).catch(() => undefined);
    inbound.process.mockResolvedValue({ processed: 1, duplicates: 0, unknown: 0, ignored: 0, unrecognised: 0 });
    await primary.receive(req(), sigA()); // healthy again
    inbound.process.mockResolvedValue({ processed: 0, duplicates: 0, unknown: 0, ignored: 0, unrecognised: 1 });
    await primary.receive(req(), sigA()).catch(() => undefined);
    const l = lines();
    expect(l.map((x) => /route=(\w+) .*consecutive=(\d+)/.exec(x)!.slice(1).join(':'))).toEqual(['primary:1', 'primary:2', 'signup:1', 'primary:1']);
  });
  it('logs no account ids, tokens or payload content', async () => {
    const { primary, inbound } = make();
    inbound.process.mockResolvedValue({ processed: 0, duplicates: 0, unknown: 0, ignored: 0, unrecognised: 1 });
    await primary.receive(req(), sigA()).catch(() => undefined);
    const text = JSON.stringify(errorSpy.mock.calls);
    for (const secret of [ENV.WHATSAPP_APP_SECRET, ENV.WHATSAPP_SIGNUP_APP_SECRET, 'PN1', 'WABA1', 'wamid.1']) expect(text).not.toContain(secret);
  });
  it('invalid signatures never reach the signal', async () => {
    const { primary } = make();
    await expect(primary.receive(req(), sigB())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(lines()).toHaveLength(0);
  });
});
