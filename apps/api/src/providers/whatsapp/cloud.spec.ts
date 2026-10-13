import { resetConfigForTests } from '../../config/config';
import { mapTemplateStatus } from '../../modules/whatsapp/whatsapp-account.service';
import { classifyMetaError } from './meta-errors';
import { CloudWhatsApp, parseCloudPayload, WaSendError } from './whatsapp';

// These tests use MOCKED HTTP shaped like Meta's documented responses. They prove our request/response handling,
// not that the live service behaves identically (verify against Meta; see docs/WHATSAPP_INTEGRATION_DESIGN.md §11).
const acct = { phoneNumberId: 'PN1', wabaId: 'WABA1', token: 'tok-123456' };
let fetchMock: jest.SpyInstance;
const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

beforeAll(() => {
  Object.assign(process.env, { DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789', WHATSAPP_API_BASE_URL: 'https://graph.test/v99.0' });
  resetConfigForTests();
});
beforeEach(() => { fetchMock = jest.spyOn(global, 'fetch'); });
afterEach(() => fetchMock.mockRestore());
afterAll(resetConfigForTests);

const call = (n = 0) => ({ url: String(fetchMock.mock.calls[n][0]), init: fetchMock.mock.calls[n][1] as RequestInit });

describe('CloudWhatsApp requests', () => {
  it('sends text with bearer auth to the phone number messages endpoint', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { messages: [{ id: 'wamid.X' }] }));
    const r = await new CloudWhatsApp().sendText(acct, '+919800000000', 'hello');
    expect(r).toEqual({ providerMessageId: 'wamid.X', simulated: false });
    const { url, init } = call();
    expect(url).toBe('https://graph.test/v99.0/PN1/messages');
    expect((init.headers as any).Authorization).toBe('Bearer tok-123456');
    expect(JSON.parse(init.body as string)).toMatchObject({ messaging_product: 'whatsapp', to: '919800000000', type: 'text', text: { body: 'hello' } });
  });

  it('reads phone health with the expected fields', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { display_phone_number: '+91 98000 00000', verified_name: 'Golden Travels', name_status: 'APPROVED', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', status: 'CONNECTED' }));
    const info = await new CloudWhatsApp().getPhoneInfo(acct);
    expect(call().url).toContain('/PN1?fields=display_phone_number,verified_name,name_status,quality_rating,messaging_limit_tier,status');
    expect(info).toEqual({ displayPhoneNumber: '+91 98000 00000', verifiedName: 'Golden Travels', displayNameStatus: 'APPROVED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K', status: 'CONNECTED' });
  });

  it('subscribes the app to the WABA webhooks, and needs a WABA id', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { success: true }));
    await new CloudWhatsApp().subscribeWebhooks(acct);
    expect(call().url).toBe('https://graph.test/v99.0/WABA1/subscribed_apps');
    expect(call().init.method).toBe('POST');
    await expect(new CloudWhatsApp().subscribeWebhooks({ ...acct, wabaId: undefined })).rejects.toMatchObject({ code: 'no_waba' });
  });

  it('lists templates across pages and extracts the body and rejection reason', async () => {
    fetchMock
      .mockReturnValueOnce(reply(200, { data: [{ id: '1', name: 'quote_followup', language: 'en', category: 'UTILITY', status: 'APPROVED', rejected_reason: 'NONE', components: [{ type: 'HEADER', text: 'h' }, { type: 'BODY', text: 'Hi {{1}}, quote {{2}}' }] }], paging: { next: 'https://graph.test/v99.0/WABA1/message_templates?after=abc' } }))
      .mockReturnValueOnce(reply(200, { data: [{ id: '2', name: 'promo', language: 'en', category: 'MARKETING', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', components: [{ type: 'BODY', text: 'Sale' }] }] }));
    const list = await new CloudWhatsApp().listTemplates(acct);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(1).url).toContain('after=abc');
    expect(list).toEqual([
      { providerTemplateId: '1', name: 'quote_followup', language: 'en', category: 'UTILITY', status: 'APPROVED', body: 'Hi {{1}}, quote {{2}}', rejectedReason: undefined },
      { providerTemplateId: '2', name: 'promo', language: 'en', category: 'MARKETING', status: 'REJECTED', body: 'Sale', rejectedReason: 'INVALID_FORMAT' },
    ]);
  });

  it('submits a template with example values for variables', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { id: '999', status: 'PENDING', category: 'UTILITY' }));
    const r = await new CloudWhatsApp().submitTemplate(acct, { name: 'quote_followup', language: 'en', category: 'UTILITY', body: 'Hi {{1}}, quote {{2}}', variables: ['name', 'quote'] });
    expect(r).toEqual({ providerTemplateId: '999', status: 'PENDING' });
    expect(call().url).toBe('https://graph.test/v99.0/WABA1/message_templates');
    expect(JSON.parse(call().init.body as string)).toEqual({ name: 'quote_followup', language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, quote {{2}}', example: { body_text: [['Example name', 'Example quote']] } }] });
  });
});

describe('error handling', () => {
  const fail = (status: number, code?: number, message = 'boom') => fetchMock.mockReturnValueOnce(reply(status, { error: { code, message } }));
  const rejected = (p: Promise<unknown>) => p.then(() => { throw new Error('expected the call to fail'); }, (e) => e as WaSendError);
  const run = () => rejected(new CloudWhatsApp().sendText(acct, '+919800000000', 'x'));

  it.each([
    [401, 190, 'auth', false], [400, 131047, 'window_closed', false], [429, 130429, 'rate_limit', true], [400, 131056, 'rate_limit', true],
    [400, 132001, 'template', false], [400, 131026, 'recipient', false], [400, 131030, 'recipient', false], [400, 131042, 'account', false],
    [500, 1, 'transient', true], [503, undefined, 'transient', true], [400, 100, 'unknown', false],
  ])('HTTP %i code %s is classified as %s (retryable %s)', async (status, code, kind, retryable) => {
    fail(status, code as number | undefined);
    const e = await run();
    expect(e).toBeInstanceOf(WaSendError);
    expect(e.kind).toBe(kind);
    expect(e.retryable).toBe(retryable);
  });

  it('treats a network failure as transient and retryable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const e = await run();
    expect(e.kind).toBe('transient');
    expect(e.retryable).toBe(true);
  });

  it('reports a missing credential as an auth problem without calling Meta', async () => {
    const e = await rejected(new CloudWhatsApp().sendText({ phoneNumberId: 'PN1' }, '+91', 'x'));
    expect(e.kind).toBe('auth');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifier gives every kind a plain-language hint', () => {
    for (const c of [190, 131047, 130429, 132001, 131026, 131042, 368, 1]) expect(classifyMetaError(400, c).hint.length).toBeGreaterThan(20);
  });
});

describe('webhook payloads', () => {
  it('parses template status updates (identified by WABA id)', () => {
    const ev = parseCloudPayload({ entry: [{ id: 'WABA1', time: 1700000000, changes: [{ field: 'message_template_status_update', value: { event: 'REJECTED', message_template_id: 555, message_template_name: 'promo', message_template_language: 'en', reason: 'INVALID_FORMAT' } }] }] });
    expect(ev).toEqual([{ kind: 'template', wabaId: 'WABA1', providerTemplateId: '555', name: 'promo', language: 'en', event: 'REJECTED', reason: 'INVALID_FORMAT', timestamp: new Date(1700000000 * 1000) }]);
  });
  it('parses quality and account updates', () => {
    const ev = parseCloudPayload({ entry: [{ id: 'WABA1', time: 1700000000, changes: [{ field: 'phone_number_quality_update', value: { display_phone_number: '9198', event: 'DOWNGRADE', current_limit: 'TIER_250' } }, { field: 'account_update', value: { event: 'DISABLED_UPDATE' } }] }] });
    expect(ev).toMatchObject([{ kind: 'account', wabaId: 'WABA1', event: 'DOWNGRADE', detail: 'TIER_250' }, { kind: 'account', wabaId: 'WABA1', event: 'DISABLED_UPDATE' }]);
  });
  it('still parses messages and statuses alongside other fields', () => {
    const ev = parseCloudPayload({ entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, statuses: [{ id: 'w1', status: 'delivered', timestamp: '1700000000' }] } }] }] });
    expect(ev).toMatchObject([{ kind: 'status', phoneNumberId: 'PN1', providerMessageId: 'w1', status: 'delivered' }]);
  });
  it('ignores unknown fields safely', () => {
    expect(parseCloudPayload({ entry: [{ id: 'W', changes: [{ field: 'something_new', value: {} }] }] })).toEqual([]);
  });
});

describe('template status mapping', () => {
  it.each([['APPROVED', 'approved'], ['REINSTATED', 'approved'], ['REJECTED', 'rejected'], ['PENDING', 'pending'], ['IN_APPEAL', 'pending'], ['PAUSED', 'paused'], ['DISABLED', 'paused'], ['DELETED', 'paused'], ['FLAGGED', null], ['whatever', null]])('%s -> %s', (m, expected) => {
    expect(mapTemplateStatus(m as string)).toBe(expected);
  });
});
