import { resetConfigForTests } from '../../config/config';
import { useHermeticEnv } from '../../../test/hermetic-env';
import { mapTemplateStatus } from '../../modules/whatsapp/whatsapp-account.service';
import { classifyMetaError } from './meta-errors';
import { CloudWhatsApp, parseCloudPayload, WaSendError } from './whatsapp';

// These tests use MOCKED HTTP shaped like Meta's documented responses. They prove our request/response handling,
// not that the live service behaves identically (verify against Meta; see docs/WHATSAPP_INTEGRATION_DESIGN.md §11).
const acct = { phoneNumberId: 'PN1', wabaId: 'WABA1', token: 'tok-123456' };
let fetchMock: jest.SpyInstance;
const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

// These tests describe a primary-app-only setup; the hermetic env keeps the developer's real .env (which may hold Embedded Signup settings) out of them.
useHermeticEnv({ DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789', WHATSAPP_API_BASE_URL: 'https://graph.test/v99.0' });
beforeEach(() => { fetchMock = jest.spyOn(global, 'fetch'); });
afterEach(() => fetchMock.mockRestore());

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

  it('submits a template exactly as compiled, including media-header examples', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { id: '999', status: 'PENDING', category: 'UTILITY' }));
    const components = [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::abc'] } }, { type: 'BODY', text: 'Hi {{1}}, quote {{2}}', example: { body_text: [['Asha', 'Q-1']] } }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'View', url: 'https://x.test/q/{{1}}', example: ['https://x.test/q/abc'] }] }];
    const r = await new CloudWhatsApp().submitTemplate(acct, { name: 'quote_followup', language: 'en', category: 'UTILITY', components });
    expect(r).toEqual({ providerTemplateId: '999', status: 'PENDING' });
    expect(call().url).toBe('https://graph.test/v99.0/WABA1/message_templates');
    expect(JSON.parse(call().init.body as string)).toEqual({ name: 'quote_followup', language: 'en', category: 'UTILITY', components });
  });

  it('sends a template with a media header, body values and a dynamic URL button in the provider component format', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { id: 'MEDIA9' })).mockReturnValueOnce(reply(200, { messages: [{ id: 'wamid.T' }] }));
    const r = await new CloudWhatsApp().sendTemplate(acct, '+919800000000', {
      name: 'quote_premium', language: 'en', variables: ['Asha', 'Golden Travels'], headerText: undefined,
      header: { kind: 'document', data: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf', filename: 'Q-0001-v1.pdf' }, buttons: [{ index: 0, kind: 'url', value: 'tok123' }],
    });
    expect(r.providerMessageId).toBe('wamid.T');
    expect(call(0).url).toBe('https://graph.test/v99.0/PN1/media');                       // header media uploaded first
    expect(JSON.parse(call(1).init.body as string).template).toEqual({
      name: 'quote_premium', language: { code: 'en' },
      components: [
        { type: 'header', parameters: [{ type: 'document', document: { id: 'MEDIA9', filename: 'Q-0001-v1.pdf' } }] },
        { type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: 'Golden Travels' }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'tok123' }] },
      ],
    });
  });

  it('sends image headers and text-header values, and a plain template without components when nothing is needed', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { id: 'IMG1' })).mockReturnValueOnce(reply(200, { messages: [{ id: 'w1' }] })).mockReturnValueOnce(reply(200, { messages: [{ id: 'w2' }] })).mockReturnValueOnce(reply(200, { messages: [{ id: 'w3' }] }));
    const wa = new CloudWhatsApp();
    await wa.sendTemplate(acct, '+919800000000', { name: 'a', language: 'en', variables: [], header: { kind: 'image', data: Buffer.from('x'), mimeType: 'image/png' } });
    expect(JSON.parse(call(1).init.body as string).template.components).toEqual([{ type: 'header', parameters: [{ type: 'image', image: { id: 'IMG1' } }] }]);
    await wa.sendTemplate(acct, '+919800000000', { name: 'b', language: 'en', variables: ['x'], headerText: 'Golden Travels' });
    expect(JSON.parse(call(2).init.body as string).template.components).toEqual([{ type: 'header', parameters: [{ type: 'text', text: 'Golden Travels' }] }, { type: 'body', parameters: [{ type: 'text', text: 'x' }] }]);
    await wa.sendTemplate(acct, '+919800000000', { name: 'c', language: 'en', variables: [] });
    expect(JSON.parse(call(3).init.body as string).template.components).toEqual([]);
  });

  it('uploads a header example with the two-step resumable upload on the APP and returns the handle', async () => {
    process.env.WHATSAPP_APP_ID = 'APP77'; resetConfigForTests();
    fetchMock.mockReturnValueOnce(reply(200, { id: 'upload:SESSION1' })).mockReturnValueOnce(reply(200, { h: '4::HANDLE' }));
    const h = await new CloudWhatsApp().uploadTemplateExample(acct, { data: Buffer.from('12345'), mimeType: 'image/jpeg', filename: 'logo.jpg' });
    expect(h).toBe('4::HANDLE');
    expect(call(0).url).toBe('https://graph.test/v99.0/APP77/uploads?file_name=logo.jpg&file_length=5&file_type=image%2Fjpeg');
    expect(call(0).init.method).toBe('POST');
    expect(call(1).url).toBe('https://graph.test/v99.0/upload:SESSION1');
    expect((call(1).init.headers as any).Authorization).toBe('OAuth tok-123456');       // step 2 uses OAuth, not Bearer
    expect((call(1).init.headers as any).file_offset).toBe('0');
    delete process.env.WHATSAPP_APP_ID; resetConfigForTests();
    await expect(new CloudWhatsApp().uploadTemplateExample(acct, { data: Buffer.from('1'), mimeType: 'image/png', filename: 'x.png' })).rejects.toMatchObject({ code: 'no_app_id' });
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
