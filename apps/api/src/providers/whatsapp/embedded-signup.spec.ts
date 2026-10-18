import { resetConfigForTests, validateConfig } from '../../config/config';
import { useHermeticEnv } from '../../../test/hermetic-env';
import { metaSignatureHeader } from './signature';
import { CloudWhatsApp, parseCloudPayload, SimulatorWhatsApp, WaSendError } from './whatsapp';

// MOCKED HTTP shaped like Meta's documented Embedded Signup / coexistence requests and webhooks (developers.facebook.com, Oct 2026).
// These prove our request/response handling, not that the live service behaves identically.
const acct = { phoneNumberId: 'PN1', wabaId: 'WABA1', token: 'business-token-123' };
const SECRET = 'primary-app-secret-do-not-leak'; // the existing Cloud API app
const SIGNUP_SECRET = 'signup-app-secret-do-not-leak'; // the Embedded Signup app
let fetchMock: jest.SpyInstance;
const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('expected the call to fail'); }, (e) => e as WaSendError);
const call = (n = 0) => ({ url: String(fetchMock.mock.calls[n][0]), init: (fetchMock.mock.calls[n][1] ?? {}) as RequestInit });

useHermeticEnv({ DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789', WHATSAPP_API_BASE_URL: 'https://graph.test/v99.0', WHATSAPP_APP_ID: 'APP123', WHATSAPP_APP_SECRET: SECRET, WHATSAPP_PROVIDER: 'cloud', WHATSAPP_VERIFY_TOKEN: 'unit-verify-token', WHATSAPP_SIGNUP_APP_ID: 'SIGNUPAPP', WHATSAPP_SIGNUP_APP_SECRET: SIGNUP_SECRET, WHATSAPP_SIGNUP_VERIFY_TOKEN: 'unit-signup-verify' });
beforeEach(() => { fetchMock = jest.spyOn(global, 'fetch'); });
afterEach(() => fetchMock.mockRestore());

describe('Embedded Signup requests (Cloud provider)', () => {
  it('exchanges the code server-side with the SIGNUP app id and secret only (never the primary app), without a bearer header', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { access_token: 'tok-abc', token_type: 'bearer' }));
    const r = await new CloudWhatsApp().exchangeSignupCode('the-code');
    expect(r).toEqual({ accessToken: 'tok-abc' });
    const { url, init } = call();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://graph.test/v99.0/oauth/access_token');
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: 'SIGNUPAPP', client_secret: SIGNUP_SECRET, code: 'the-code' });
    expect(url).not.toContain(SECRET); // the primary app's secret is never sent for a signup code
    expect(url).not.toContain('APP123');
    expect(init.method ?? 'GET').toBe('GET');
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization/i);
  });

  it('classifies an invalid or expired code as a non-retryable auth problem and never leaks the secret', async () => {
    fetchMock.mockReturnValueOnce(reply(400, { error: { code: 100, message: 'This authorization code has expired.' } }));
    const e = await failure(new CloudWhatsApp().exchangeSignupCode('old'));
    expect(e).toBeInstanceOf(WaSendError);
    expect(e.kind).toBe('auth');
    expect(e.retryable).toBe(false);
    expect(JSON.stringify({ m: e.message, c: e.code })).not.toContain(SIGNUP_SECRET);
    expect(JSON.stringify({ m: e.message, c: e.code })).not.toContain(SECRET);
  });

  it('reports a network failure without echoing the request URL (which carries the secret)', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`connect ECONNREFUSED https://graph.test/v99.0/oauth/access_token?client_secret=${SIGNUP_SECRET}`));
    const e = await failure(new CloudWhatsApp().exchangeSignupCode('c'));
    expect(e.kind).toBe('transient');
    expect(e.message).not.toContain(SIGNUP_SECRET);
    expect(e.message).not.toContain('graph.test');
  });

  it('refuses to exchange when the signup app is not configured and does NOT fall back to the primary app', async () => {
    // The primary app id/secret stay configured on purpose: they must never be borrowed for a signup code.
    for (const k of ['WHATSAPP_SIGNUP_APP_ID', 'WHATSAPP_SIGNUP_APP_SECRET', 'WHATSAPP_SIGNUP_VERIFY_TOKEN']) delete process.env[k];
    resetConfigForTests();
    try {
      await expect(new CloudWhatsApp().exchangeSignupCode('c')).rejects.toMatchObject({ code: 'not_configured' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      Object.assign(process.env, { WHATSAPP_SIGNUP_APP_ID: 'SIGNUPAPP', WHATSAPP_SIGNUP_APP_SECRET: SIGNUP_SECRET, WHATSAPP_SIGNUP_VERIFY_TOKEN: 'unit-signup-verify' });
      resetConfigForTests();
    }
  });

  it('fails clearly if Meta answers 200 without a token', async () => {
    fetchMock.mockReturnValueOnce(reply(200, {}));
    await expect(new CloudWhatsApp().exchangeSignupCode('c')).rejects.toMatchObject({ code: 'no_token' });
  });

  it('lists the phone numbers of a WABA with the business token', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { data: [{ id: 'PN1', display_phone_number: '+91 98000 00000', verified_name: 'Golden Travels' }] }));
    expect(await new CloudWhatsApp().listWabaPhoneNumbers(acct)).toEqual([{ id: 'PN1', displayPhoneNumber: '+91 98000 00000', verifiedName: 'Golden Travels' }]);
    expect(call().url).toContain('/WABA1/phone_numbers?fields=id,display_phone_number,verified_name');
    expect((call().init.headers as any).Authorization).toBe('Bearer business-token-123');
    await expect(new CloudWhatsApp().listWabaPhoneNumbers({ ...acct, wabaId: undefined })).rejects.toMatchObject({ code: 'no_waba' });
  });

  it('reads coexistence status from is_on_biz_app', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { is_on_biz_app: true, platform_type: 'CLOUD_API', id: 'PN1' }));
    expect(await new CloudWhatsApp().getCoexistenceInfo(acct)).toEqual({ isOnBizApp: true, platformType: 'CLOUD_API' });
    expect(call().url).toContain('/PN1?fields=is_on_biz_app,platform_type');
    fetchMock.mockReturnValueOnce(reply(200, { platform_type: 'CLOUD_API', id: 'PN1' }));
    expect((await new CloudWhatsApp().getCoexistenceInfo(acct)).isOnBizApp).toBe(false);
  });

  it('requests contacts and history through the SMB app data endpoint', async () => {
    fetchMock.mockReturnValue(reply(200, { success: true }));
    await new CloudWhatsApp().requestSmbSync(acct, 'smb_app_state_sync');
    await new CloudWhatsApp().requestSmbSync(acct, 'history');
    expect(call(0).url).toBe('https://graph.test/v99.0/PN1/smb_app_data');
    expect(call(0).init.method).toBe('POST');
    expect(JSON.parse(call(0).init.body as string)).toEqual({ messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' });
    expect(JSON.parse(call(1).init.body as string)).toEqual({ messaging_product: 'whatsapp', sync_type: 'history' });
  });
});

describe('app-specific operations use the app that issued the token', () => {
  const file = { data: Buffer.from('12345'), mimeType: 'image/png', filename: 'x.png' };
  const sessions = () => { fetchMock.mockReturnValueOnce(reply(200, { id: 'upload:1' })).mockReturnValueOnce(reply(200, { h: '4::handle' })); };
  const restoreSignup = () => { Object.assign(process.env, { WHATSAPP_SIGNUP_APP_ID: 'SIGNUPAPP', WHATSAPP_SIGNUP_APP_SECRET: SIGNUP_SECRET, WHATSAPP_SIGNUP_VERIFY_TOKEN: 'unit-signup-verify' }); resetConfigForTests(); };
  const dropSignup = () => { for (const k of ['WHATSAPP_SIGNUP_APP_ID', 'WHATSAPP_SIGNUP_APP_SECRET', 'WHATSAPP_SIGNUP_VERIFY_TOKEN']) delete process.env[k]; resetConfigForTests(); };

  it('template-header upload for a legacy account (no app recorded) uses the PRIMARY app', async () => {
    sessions();
    expect(await new CloudWhatsApp().uploadTemplateExample(acct, file)).toBe('4::handle');
    expect(call(0).url).toContain('/APP123/uploads?');
    expect(call(0).url).not.toContain('SIGNUPAPP');
  });
  it('template-header upload for a signup account uses the SIGNUP app, not the primary one', async () => {
    sessions();
    await new CloudWhatsApp().uploadTemplateExample({ ...acct, appId: 'SIGNUPAPP' }, file);
    expect(call(0).url).toContain('/SIGNUPAPP/uploads?');
    expect(call(0).url).not.toContain('APP123');
  });
  it('an explicit primary app id also uses the primary app', async () => {
    sessions();
    await new CloudWhatsApp().uploadTemplateExample({ ...acct, appId: 'APP123' }, file);
    expect(call(0).url).toContain('/APP123/uploads?');
  });
  it('refuses an account tied to an app that is not configured here, without calling Meta', async () => {
    await expect(new CloudWhatsApp().uploadTemplateExample({ ...acct, appId: 'SOME_OLD_APP' }, file)).rejects.toMatchObject({ code: 'unknown_app' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('a signup account whose app is no longer configured is refused rather than falling back to the primary app', async () => {
    dropSignup();
    try {
      await expect(new CloudWhatsApp().uploadTemplateExample({ ...acct, appId: 'SIGNUPAPP' }, file)).rejects.toMatchObject({ code: 'unknown_app' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { restoreSignup(); }
  });
});

describe("webhook signature selects exactly one app's secret", () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  it('primary signatures verify only as primary; signup signatures only as signup; the default is primary', () => {
    const wa = new CloudWhatsApp();
    const a = metaSignatureHeader(body, SECRET), b = metaSignatureHeader(body, SIGNUP_SECRET);
    expect(wa.verifySignature(body, a, 'primary')).toBe(true);
    expect(wa.verifySignature(body, a)).toBe(true);
    expect(wa.verifySignature(body, b, 'signup')).toBe(true);
    expect(wa.verifySignature(body, b, 'primary')).toBe(false);
    expect(wa.verifySignature(body, b)).toBe(false);
    expect(wa.verifySignature(body, a, 'signup')).toBe(false);
  });
  it('an unconfigured signup app verifies nothing (no fallback to the primary secret)', () => {
    for (const k of ['WHATSAPP_SIGNUP_APP_ID', 'WHATSAPP_SIGNUP_APP_SECRET', 'WHATSAPP_SIGNUP_VERIFY_TOKEN']) delete process.env[k];
    resetConfigForTests();
    try {
      const wa = new CloudWhatsApp();
      expect(wa.verifySignature(body, metaSignatureHeader(body, SECRET), 'signup')).toBe(false);
      expect(wa.verifySignature(body, metaSignatureHeader(body, ''), 'signup')).toBe(false);
      expect(wa.verifySignature(body, metaSignatureHeader(body, SECRET), 'primary')).toBe(true); // primary unaffected
    } finally {
      Object.assign(process.env, { WHATSAPP_SIGNUP_APP_ID: 'SIGNUPAPP', WHATSAPP_SIGNUP_APP_SECRET: SIGNUP_SECRET, WHATSAPP_SIGNUP_VERIFY_TOKEN: 'unit-signup-verify' });
      resetConfigForTests();
    }
  });
});

describe('Embedded Signup simulator', () => {
  it('accepts a registered code once, then rejects it (like Meta)', async () => {
    const sim = new SimulatorWhatsApp();
    sim.signupFixtures.set('c1', { wabaId: 'W', phoneNumberId: 'P', isOnBizApp: true });
    const { accessToken } = await sim.exchangeSignupCode('c1');
    expect(await sim.listWabaPhoneNumbers({ phoneNumberId: '', wabaId: 'W', token: accessToken })).toHaveLength(1);
    expect(await sim.getCoexistenceInfo({ phoneNumberId: 'P', wabaId: 'W', token: accessToken })).toMatchObject({ isOnBizApp: true });
    await expect(sim.exchangeSignupCode('c1')).rejects.toMatchObject({ code: 'code_invalid' });
    await expect(sim.listWabaPhoneNumbers({ phoneNumberId: '', wabaId: 'OTHER', token: accessToken })).rejects.toBeInstanceOf(WaSendError);
    await expect(sim.listWabaPhoneNumbers({ phoneNumberId: '', wabaId: 'W', token: 'bogus' })).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('coexistence webhook payloads (shapes from Meta\'s webhook reference)', () => {
  const wrap = (field: string, value: object, entryId = 'WABA1') => ({ object: 'whatsapp_business_account', entry: [{ id: entryId, time: 1748477359, changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '919800000000', phone_number_id: 'PN1' }, ...value } }] }] });

  it('parses smb_message_echoes: a message the business sent from the app', () => {
    const ev = parseCloudPayload(wrap('smb_message_echoes', { message_echoes: [{ from: '919800000000', to: '919811111111', id: 'wamid.E1', timestamp: '1748477000', type: 'text', text: { body: 'Hi from the app' } }] }));
    expect(ev).toEqual([{ kind: 'echo', phoneNumberId: 'PN1', providerMessageId: 'wamid.E1', to: '+919811111111', type: 'text', text: 'Hi from the app', action: undefined, timestamp: new Date(1748477000 * 1000) }]);
  });
  it('flags edit and revoke echoes so they are not stored as new messages', () => {
    const ev = parseCloudPayload(wrap('smb_message_echoes', { message_echoes: [{ from: '1', to: '2', id: 'wamid.R', timestamp: '1', type: 'revoke', revoke: { original_message_id: 'wamid.E1' } }, { from: '1', to: '2', id: 'wamid.D', timestamp: '1', type: 'edit', edit: { original_message_id: 'wamid.E1', message: { text: { body: 'x' } } } }] }));
    expect(ev.map((e: any) => e.action)).toEqual(['revoke', 'edit']);
  });
  it('parses history chunks, deriving direction from the thread owner', () => {
    const ev = parseCloudPayload(wrap('history', { history: [{ metadata: { phase: 1, chunk_order: 2, progress: 55 }, threads: [{ id: '919811111111', messages: [
      { from: '919811111111', id: 'wamid.H1', timestamp: '1700000000', type: 'text', text: { body: 'hello' }, history_context: { status: 'READ' } },
      { from: '919800000000', id: 'wamid.H2', timestamp: '1700000100', type: 'text', text: { body: 'reply' }, history_context: { status: 'DELIVERED' } },
      { from: '919811111111', id: 'wamid.H3', timestamp: '1700000200', type: 'media_placeholder', history_context: { status: 'READ' } },
    ] }] }] }));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'history', phoneNumberId: 'PN1', phase: 1, chunkOrder: 2, progress: 55 });
    expect((ev[0] as any).messages.map((m: any) => [m.providerMessageId, m.direction, m.customerPhone, m.status])).toEqual([
      ['wamid.H1', 'inbound', '+919811111111', 'READ'], ['wamid.H2', 'outbound', '+919811111111', 'DELIVERED'], ['wamid.H3', 'inbound', '+919811111111', 'READ'],
    ]);
  });
  it('parses a declined history share (error 2593109)', () => {
    const ev = parseCloudPayload(wrap('history', { history: [{ errors: [{ code: 2593109, title: 'History sync is turned off by the business from the WhatsApp Business App' }] }] }));
    expect(ev).toMatchObject([{ kind: 'history', declined: { code: '2593109' }, messages: [] }]);
  });
  it('parses smb_app_state_sync contacts (add and remove)', () => {
    const ev = parseCloudPayload(wrap('smb_app_state_sync', { state_sync: [
      { type: 'contact', contact: { full_name: 'Pablo Morales', first_name: 'Pablo', phone_number: '16505551234' }, action: 'add', metadata: { timestamp: '1739321024' } },
      { type: 'contact', contact: { phone_number: '16505559999' }, action: 'remove', metadata: { timestamp: '1739321025' } },
      { type: 'something_else', action: 'add' },
    ] }));
    expect(ev).toHaveLength(1);
    expect((ev[0] as any).items.map((i: any) => [i.action, i.phone, i.fullName])).toEqual([['add', '+16505551234', 'Pablo Morales'], ['remove', '+16505559999', undefined]]);
  });
  it('parses PARTNER_REMOVED using waba_info, because entry.id may be a partner business id', () => {
    const ev = parseCloudPayload({ object: 'whatsapp_business_account', entry: [{ id: 'PARTNER_BUSINESS', time: 1748477359, changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED', waba_info: { waba_id: 'WABA1', owner_business_id: 'OWNER' }, disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' } } }] }] });
    expect(ev).toMatchObject([{ kind: 'account', wabaId: 'WABA1', event: 'PARTNER_REMOVED', disconnectionReason: 'PRIMARY_INACTIVITY', initiatedBy: 'SYSTEM' }]);
  });
  it('ignores coexistence fields that carry no phone_number_id', () => {
    expect(parseCloudPayload({ entry: [{ id: 'W', changes: [{ field: 'smb_message_echoes', value: { message_echoes: [{ id: 'x' }] } }, { field: 'history', value: { history: [] } }] }] })).toEqual([]);
  });
});

describe('Embedded Signup configuration (two Meta apps)', () => {
  const base = { DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789' };
  const cloud = { ...base, WHATSAPP_PROVIDER: 'cloud', WHATSAPP_APP_SECRET: 'p-secret', WHATSAPP_VERIFY_TOKEN: 'p-verify' };
  const trio = { WHATSAPP_SIGNUP_APP_ID: 'S_ID', WHATSAPP_SIGNUP_APP_SECRET: 's-secret', WHATSAPP_SIGNUP_VERIFY_TOKEN: 's-verify' };

  it('is disabled by default and needs none of the signup values', () => {
    const c = validateConfig(base);
    expect(c.WHATSAPP_EMBEDDED_SIGNUP_ENABLED).toBe(false);
    expect(c.WHATSAPP_SIGNUP_APP_ID).toBeUndefined();
  });
  it('flag OFF: an existing primary-only cloud setup is valid and unchanged', () => {
    expect(() => validateConfig({ ...cloud, WHATSAPP_APP_ID: 'P_ID' })).not.toThrow();
    expect(() => validateConfig(cloud)).not.toThrow();
  });
  it('flag OFF: the signup app may already be configured (inert) with a different app id and secret', () => {
    const c = validateConfig({ ...cloud, WHATSAPP_APP_ID: 'P_ID', ...trio });
    expect(c.WHATSAPP_EMBEDDED_SIGNUP_ENABLED).toBe(false);
    expect(c.WHATSAPP_SIGNUP_APP_ID).toBe('S_ID');
  });
  it('flag ON with the cloud provider: requires the whole signup trio and the configuration id, with no fallback to the primary values', () => {
    const on = { ...cloud, WHATSAPP_APP_ID: 'P_ID', WHATSAPP_EMBEDDED_SIGNUP_ENABLED: 'true' };
    expect(() => validateConfig(on)).toThrow(/WHATSAPP_SIGNUP_APP_ID[\s\S]*WHATSAPP_SIGNUP_APP_SECRET[\s\S]*WHATSAPP_SIGNUP_VERIFY_TOKEN[\s\S]*WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID/);
    expect(() => validateConfig({ ...on, ...trio })).toThrow(/WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID/);
    expect(validateConfig({ ...on, ...trio, WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: 'C' }).WHATSAPP_EMBEDDED_SIGNUP_ENABLED).toBe(true);
  });
  it('flag ON with the simulator provider needs no Meta values', () => {
    expect(() => validateConfig({ ...base, WHATSAPP_PROVIDER: 'simulator', WHATSAPP_EMBEDDED_SIGNUP_ENABLED: 'true' })).not.toThrow();
  });
  it('the signup values are all-or-nothing, flag or no flag', () => {
    expect(() => validateConfig({ ...cloud, WHATSAPP_SIGNUP_APP_ID: 'S_ID' })).toThrow(/WHATSAPP_SIGNUP_APP_SECRET, WHATSAPP_SIGNUP_VERIFY_TOKEN must be set together/);
    expect(() => validateConfig({ ...cloud, WHATSAPP_SIGNUP_APP_SECRET: 's' })).toThrow(/WHATSAPP_SIGNUP_APP_ID, WHATSAPP_SIGNUP_VERIFY_TOKEN must be set together/);
    expect(() => validateConfig({ ...cloud, WHATSAPP_SIGNUP_VERIFY_TOKEN: 'v' })).toThrow(/must be set together/);
  });
  it("catches a copy-paste of the wrong app's secret (same id needs the same secret, different ids need different secrets) without printing values", () => {
    const wrong = { ...cloud, WHATSAPP_APP_ID: 'P_ID', ...trio, WHATSAPP_SIGNUP_APP_SECRET: 'p-secret' }; // different app ids, same secret
    let message = '';
    try { validateConfig(wrong); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/inconsistent/);
    expect(message).not.toContain('p-secret');
    expect(() => validateConfig({ ...cloud, WHATSAPP_APP_ID: 'SAME', ...trio, WHATSAPP_SIGNUP_APP_ID: 'SAME' })).toThrow(/inconsistent/); // same app id, different secrets
    expect(() => validateConfig({ ...cloud, WHATSAPP_APP_ID: 'SAME', WHATSAPP_SIGNUP_APP_ID: 'SAME', WHATSAPP_SIGNUP_APP_SECRET: 'p-secret', WHATSAPP_SIGNUP_VERIFY_TOKEN: 'v' })).not.toThrow(); // a genuine single-app setup
  });
});

describe('system-user token flow (60-day Embedded Signup configuration), mocked HTTP', () => {
  it('uses only access_token from the exchange; token_type / expires_in / extra fields are ignored and never returned', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { access_token: 'sys-user-token-xyz', token_type: 'bearer', expires_in: 5183944, data_access_expires_at: 1900000000, extra: { a: 1 } }));
    const r = await new CloudWhatsApp().exchangeSignupCode('code-1');
    expect(r).toEqual({ accessToken: 'sys-user-token-xyz' });
    expect(JSON.stringify(r)).not.toMatch(/expires|bearer|extra/);
  });

  it('follows paging when listing a WABA\'s phone numbers, sending the business token on every page', async () => {
    const next = 'https://graph.test/v99.0/WABA1/phone_numbers?after=CURSOR';
    fetchMock.mockReturnValueOnce(reply(200, { data: [{ id: 'P1', display_phone_number: '+91 1' }], paging: { next } })).mockReturnValueOnce(reply(200, { data: [{ id: 'P2' }] }));
    const out = await new CloudWhatsApp().listWabaPhoneNumbers(acct);
    expect(out.map((p) => p.id)).toEqual(['P1', 'P2']);
    expect(call(1).url).toBe(next);
    expect((call(0).init.headers as any).Authorization).toBe('Bearer business-token-123');
    expect((call(1).init.headers as any).Authorization).toBe('Bearer business-token-123');
  });

  it('an empty list is an empty list (not an error)', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { data: [] }));
    expect(await new CloudWhatsApp().listWabaPhoneNumbers(acct)).toEqual([]);
  });

  it('a permission failure while listing (the token\'s system user has no access to the WABA) surfaces Meta\'s code and classification, without echoing the token', async () => {
    fetchMock.mockReturnValueOnce(reply(403, { error: { code: 200, message: '(#200) Requires whatsapp_business_management permission or asset access' } }));
    const e = await failure(new CloudWhatsApp().listWabaPhoneNumbers(acct));
    expect(e).toBeInstanceOf(WaSendError);
    expect(e.code).toBe('200');
    expect(e.kind).toBe('auth');
    expect(e.retryable).toBe(false);
    expect(JSON.stringify({ m: e.message, c: e.code })).not.toContain('business-token-123');
  });

  it('a permission failure on the coexistence check is classified the same way', async () => {
    fetchMock.mockReturnValueOnce(reply(400, { error: { code: 10, message: 'Application does not have permission for this action' } }));
    const e = await failure(new CloudWhatsApp().getCoexistenceInfo(acct));
    expect(e.kind).toBe('auth');
  });
});
