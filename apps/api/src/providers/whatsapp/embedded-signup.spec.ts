import { resetConfigForTests, validateConfig } from '../../config/config';
import { CloudWhatsApp, parseCloudPayload, SimulatorWhatsApp, WaSendError } from './whatsapp';

// MOCKED HTTP shaped like Meta's documented Embedded Signup / coexistence requests and webhooks (developers.facebook.com, Oct 2026).
// These prove our request/response handling, not that the live service behaves identically.
const acct = { phoneNumberId: 'PN1', wabaId: 'WABA1', token: 'business-token-123' };
const SECRET = 'app-secret-do-not-leak';
let fetchMock: jest.SpyInstance;
const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('expected the call to fail'); }, (e) => e as WaSendError);
const call = (n = 0) => ({ url: String(fetchMock.mock.calls[n][0]), init: (fetchMock.mock.calls[n][1] ?? {}) as RequestInit });

beforeAll(() => {
  Object.assign(process.env, { DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789', WHATSAPP_API_BASE_URL: 'https://graph.test/v99.0', WHATSAPP_APP_ID: 'APP123', WHATSAPP_APP_SECRET: SECRET, WHATSAPP_PROVIDER: 'cloud', WHATSAPP_VERIFY_TOKEN: 'unit-verify-token' });
  resetConfigForTests();
});
beforeEach(() => { fetchMock = jest.spyOn(global, 'fetch'); });
afterEach(() => fetchMock.mockRestore());
afterAll(() => { for (const k of ['WHATSAPP_APP_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_PROVIDER', 'WHATSAPP_VERIFY_TOKEN']) delete process.env[k]; resetConfigForTests(); });

describe('Embedded Signup requests (Cloud provider)', () => {
  it('exchanges the code server-side with the app id and secret, without a bearer header', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { access_token: 'tok-abc', token_type: 'bearer' }));
    const r = await new CloudWhatsApp().exchangeSignupCode('the-code');
    expect(r).toEqual({ accessToken: 'tok-abc' });
    const { url, init } = call();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://graph.test/v99.0/oauth/access_token');
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: 'APP123', client_secret: SECRET, code: 'the-code' });
    expect(init.method ?? 'GET').toBe('GET');
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization/i);
  });

  it('classifies an invalid or expired code as a non-retryable auth problem and never leaks the secret', async () => {
    fetchMock.mockReturnValueOnce(reply(400, { error: { code: 100, message: 'This authorization code has expired.' } }));
    const e = await failure(new CloudWhatsApp().exchangeSignupCode('old'));
    expect(e).toBeInstanceOf(WaSendError);
    expect(e.kind).toBe('auth');
    expect(e.retryable).toBe(false);
    expect(JSON.stringify({ m: e.message, c: e.code })).not.toContain(SECRET);
  });

  it('reports a network failure without echoing the request URL (which carries the secret)', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`connect ECONNREFUSED https://graph.test/v99.0/oauth/access_token?client_secret=${SECRET}`));
    const e = await failure(new CloudWhatsApp().exchangeSignupCode('c'));
    expect(e.kind).toBe('transient');
    expect(e.message).not.toContain(SECRET);
    expect(e.message).not.toContain('graph.test');
  });

  it('refuses to exchange when the app id or secret is not configured, without calling Meta', async () => {
    // (Under the cloud provider the config itself already requires the secret; this guards the adapter independently.)
    delete process.env.WHATSAPP_APP_SECRET; process.env.WHATSAPP_PROVIDER = 'simulator'; resetConfigForTests();
    try {
      await expect(new CloudWhatsApp().exchangeSignupCode('c')).rejects.toMatchObject({ code: 'not_configured' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { process.env.WHATSAPP_APP_SECRET = SECRET; process.env.WHATSAPP_PROVIDER = 'cloud'; resetConfigForTests(); }
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

describe('Embedded Signup configuration', () => {
  const base = { DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789' };
  it('is disabled by default', () => {
    expect(validateConfig(base).WHATSAPP_EMBEDDED_SIGNUP_ENABLED).toBe(false);
  });
  it('needs the app id, secret and configuration id when enabled with the cloud provider', () => {
    const env = { ...base, WHATSAPP_PROVIDER: 'cloud', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'v', WHATSAPP_EMBEDDED_SIGNUP_ENABLED: 'true' };
    expect(() => validateConfig(env)).toThrow(/WHATSAPP_APP_ID[\s\S]*WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID/);
    expect(validateConfig({ ...env, WHATSAPP_APP_ID: 'a', WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: 'c' }).WHATSAPP_EMBEDDED_SIGNUP_ENABLED).toBe(true);
  });
  it('does not affect a cloud setup that leaves the flag off', () => {
    expect(() => validateConfig({ ...base, WHATSAPP_PROVIDER: 'cloud', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'v' })).not.toThrow();
  });
});
