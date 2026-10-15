import { encryptSecret } from '../../common/crypto';
import { resetConfigForTests } from '../../config/config';
import { parseCloudPayload } from '../../providers/whatsapp/whatsapp';
import { FakeDb } from '../../../test/fake-db';
import { WhatsappAccountService } from '../whatsapp/whatsapp-account.service';
import { InboundService } from './webhooks.module';

// Retry/duplicate semantics of every webhook event kind, against an in-memory database that rolls back failed transactions and can
// serialise concurrent ones (test/fake-db.ts). The point: a recorded dedupe key must never outlive a FAILED effect, and a duplicate
// must never apply twice. Real locking/RLS still need the e2e suite against a migrated database.
const ENV = {
  DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789', WHATSAPP_PROVIDER: 'cloud',
  WHATSAPP_APP_ID: 'APP_PRIMARY', WHATSAPP_APP_SECRET: 'secret-primary', WHATSAPP_VERIFY_TOKEN: 'verify-primary',
};
const KEYS = Object.keys(ENV);
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; });
beforeEach(() => { Object.assign(process.env, ENV); resetConfigForTests(); });
afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetConfigForTests(); });

const AG = 'ag-1';
const baseAccount = (over: Record<string, any> = {}) => ({
  id: 'acc-1', agencyId: AG, mode: 'cloud', phoneNumberId: 'PN1', wabaId: 'WABA1', displayName: 'Line', credentialSecretRef: encryptSecret('unit-test-token'), connectionStatus: 'connected',
  statusReason: null, webhookSubscribed: true, lastErrorCode: null, lastErrorAt: null, lastWebhookAt: null, onboardingMethod: 'embedded', isCoexistence: true, metaAppId: null, ...over,
});
const template = () => ({ id: 'tpl-1', agencyId: AG, name: 'promo', language: 'en', providerTemplateId: '555', providerStatus: 'pending', rejectedReason: null });

function setup(opts: { serialize?: boolean; account?: Record<string, any>; extra?: Record<string, any[]> } = {}) {
  const db = new FakeDb(
    { whatsappAccount: [baseAccount(opts.account)], whatsappTemplate: [template()], ...(opts.extra ?? {}) },
    { serialize: opts.serialize, unique: { webhookEvent: [['agencyId', 'eventKey']], message: [['agencyId', 'providerMessageId']], customer: [['agencyId', 'phoneE164']] } },
  );
  const wa: any = { name: 'cloud', simulated: false, getPhoneInfo: jest.fn(async () => ({ status: 'CONNECTED', qualityRating: 'GREEN' })) };
  const accounts = new WhatsappAccountService(db as any, wa);
  return { db, wa, svc: new InboundService(db as any, {} as any, wa, accounts) };
}

// ---- payloads (shapes from Meta's webhook reference)
const T0 = 1748477000;
const entry = (field: string, value: object, id = 'WABA1') => ({ id, time: T0, changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'PN1' }, ...value } }] });
const ev = (...entries: object[]) => parseCloudPayload({ entry: entries });
const templateApproved = () => entry('message_template_status_update', { event: 'APPROVED', message_template_id: 555, message_template_name: 'promo', message_template_language: 'en' });
const partnerRemoved = () => ({ id: 'PARTNER_BIZ', time: T0, changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED', waba_info: { waba_id: 'WABA1' }, disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' } } }] });
const qualityDowngrade = () => entry('phone_number_quality_update', { event: 'DOWNGRADE', current_limit: 'TIER_250' });
const contactAdded = (phone = '16505551234', ts = '1739321024') => entry('smb_app_state_sync', { state_sync: [{ type: 'contact', contact: { full_name: 'Pablo Morales', phone_number: phone }, action: 'add', metadata: { timestamp: ts } }] });
const customerMessage = (id = 'wamid.IN1') => entry('messages', { contacts: [{ wa_id: '919855500001', profile: { name: 'Pat' } }], messages: [{ id, from: '919855500001', timestamp: String(T0), type: 'text', text: { body: 'hello' } }] });
const echoEvent = (id = 'wamid.E1') => entry('smb_message_echoes', { message_echoes: [{ from: '919800000000', to: '919811111111', id, timestamp: String(T0), type: 'text', text: { body: 'from the app' } }] });
const statusEvent = (id: string, status: string) => entry('messages', { statuses: [{ id, status, timestamp: String(T0) }] });
const historyChunk = () => entry('history', { history: [{ metadata: { phase: 0, chunk_order: 1, progress: 50 }, threads: [{ id: '919822200001', messages: [
  { from: '919822200001', id: 'wamid.H1', timestamp: String(T0 - 86400 * 90), type: 'text', text: { body: 'old q' }, history_context: { status: 'READ' } },
  { from: '919800000000', id: 'wamid.H2', timestamp: String(T0 - 86400 * 90 + 60), type: 'text', text: { body: 'old a' }, history_context: { status: 'READ' } },
] }] }] });
const historyDeclined = () => entry('history', { history: [{ errors: [{ code: 2593109, title: 'History sync is turned off by the business' }] }] });
const flush = () => new Promise((r) => setImmediate(r));

describe('template events: a failed effect is retried, never suppressed', () => {
  it('rolls the dedupe key back with the failure, applies on retry, and treats a replay as a duplicate', async () => {
    const { db, svc } = setup();
    db.failOnce('whatsappTemplate.update');
    await expect(svc.process(ev(templateApproved()))).rejects.toThrow(/injected/);
    expect(db.snapshot('webhookEvent')).toHaveLength(0);
    expect(db.snapshot('whatsappTemplate')[0].providerStatus).toBe('pending');

    expect(await svc.process(ev(templateApproved()))).toMatchObject({ processed: 1, duplicates: 0 });
    expect(db.snapshot('whatsappTemplate')[0].providerStatus).toBe('approved');
    expect(db.snapshot('auditLog').map((a) => a.action)).toEqual(['template.provider_status']);

    expect(await svc.process(ev(templateApproved()))).toMatchObject({ processed: 0, duplicates: 1 });
    expect(db.snapshot('auditLog')).toHaveLength(1);
  });
});

describe('account events (including PARTNER_REMOVED): a failed effect is retried, never suppressed', () => {
  it('PARTNER_REMOVED: a failure part-way leaves the account and the key untouched; the retry disconnects exactly once', async () => {
    const { db, svc } = setup();
    const credentialBefore = db.snapshot('whatsappAccount')[0].credentialSecretRef;
    db.failOnce('auditLog.create'); // fails AFTER the account update inside the same transaction
    await expect(svc.process(ev(partnerRemoved()))).rejects.toThrow(/injected/);
    expect(db.snapshot('webhookEvent')).toHaveLength(0);
    expect(db.snapshot('whatsappAccount')[0]).toMatchObject({ connectionStatus: 'connected', credentialSecretRef: credentialBefore, lastErrorCode: null }); // update rolled back

    expect(await svc.process(ev(partnerRemoved()))).toMatchObject({ processed: 1, duplicates: 0 });
    expect(db.snapshot('whatsappAccount')[0]).toMatchObject({ connectionStatus: 'disconnected', credentialSecretRef: null, lastErrorCode: 'PARTNER_REMOVED' });
    expect(db.snapshot('auditLog').filter((a) => a.action === 'whatsapp.partner_removed')).toHaveLength(1);

    // replayed by Meta after it was applied: the account is already disconnected, so it is ignored (no second audit row)
    const replay = await svc.process(ev(partnerRemoved()));
    expect(replay).toMatchObject({ processed: 0 });
    expect(db.snapshot('auditLog').filter((a) => a.action === 'whatsapp.partner_removed')).toHaveLength(1);
  });

  it('a quality/limit change triggers its health re-read only AFTER commit, once, and not for a duplicate', async () => {
    const { db, wa, svc } = setup();
    await svc.process(ev(qualityDowngrade()));
    await flush();
    expect(wa.getPhoneInfo).toHaveBeenCalledTimes(1);
    await svc.process(ev(qualityDowngrade())); // duplicate delivery
    await flush();
    expect(wa.getPhoneInfo).toHaveBeenCalledTimes(1);
    expect(db.snapshot('webhookEvent').filter((k) => k.eventKey.startsWith('acct:'))).toHaveLength(1);
  });

  it('a failure before commit does NOT trigger the post-commit re-read', async () => {
    const { db, wa, svc } = setup();
    db.failOnce('webhookEvent.create');
    await expect(svc.process(ev(qualityDowngrade()))).rejects.toThrow();
    await flush();
    expect(wa.getPhoneInfo).not.toHaveBeenCalled();
  });
});

describe('contact syncs: a failed effect is retried, never suppressed', () => {
  it('rolls the key back with the failed upsert; the retry creates the customer once; a replay is a duplicate', async () => {
    const { db, svc } = setup();
    db.failOnce('customer.upsert');
    await expect(svc.process(ev(contactAdded()))).rejects.toThrow(/injected/);
    expect(db.snapshot('webhookEvent')).toHaveLength(0);
    expect(db.snapshot('customer')).toHaveLength(0);

    expect(await svc.process(ev(contactAdded()))).toMatchObject({ processed: 1, duplicates: 0 });
    expect(db.snapshot('customer')).toHaveLength(1);
    expect(await svc.process(ev(contactAdded()))).toMatchObject({ processed: 0, duplicates: 1 });
    expect(db.snapshot('customer')).toHaveLength(1);
  });
});

describe('concurrent duplicate delivery', () => {
  it.each([
    ['template', () => ev(templateApproved()), (db: FakeDb) => db.snapshot('auditLog').filter((a) => a.action === 'template.provider_status').length],
    ['PARTNER_REMOVED', () => ev(partnerRemoved()), (db: FakeDb) => db.snapshot('auditLog').filter((a) => a.action === 'whatsapp.partner_removed').length],
    ['contact sync', () => ev(contactAdded()), (db: FakeDb) => db.snapshot('customer').length],
  ])('%s: two simultaneous deliveries apply the effect exactly once', async (_name, events, effects) => {
    const { db, svc } = setup({ serialize: true });
    const [a, b] = await Promise.all([svc.process(events()), svc.process(events())]);
    expect(a.processed + b.processed).toBeLessThanOrEqual(1);
    expect(a.processed + b.processed + a.duplicates + b.duplicates + a.ignored + b.ignored).toBeGreaterThanOrEqual(2);
    expect(effects(db)).toBe(1);
  });

  it('if the first of two simultaneous deliveries FAILS, the second applies the event (the failure suppressed nothing)', async () => {
    const { db, svc } = setup({ serialize: true });
    db.failOnce('whatsappTemplate.update');
    const results = await Promise.allSettled([svc.process(ev(templateApproved())), svc.process(ev(templateApproved()))]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const ok = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>;
    expect(ok.value).toMatchObject({ processed: 1, duplicates: 0 });
    expect(db.snapshot('whatsappTemplate')[0].providerStatus).toBe('approved');
    expect(db.snapshot('auditLog')).toHaveLength(1);
  });
});

describe('a mixed batch retried after a failure applies every event exactly once', () => {
  it('message + template(fails once) + echo + contact: first pass stops at the failure, the retry completes the rest, the third pass is all duplicates', async () => {
    const { db, svc } = setup();
    const batch = () => ev(customerMessage(), templateApproved(), echoEvent(), contactAdded());
    db.failOnce('whatsappTemplate.update');

    await expect(svc.process(batch())).rejects.toThrow(/injected/); // Meta would see a 5xx and retry the whole batch
    expect(db.snapshot('message').map((m) => m.providerMessageId)).toEqual(['wamid.IN1']); // the message before it was applied (own transaction)
    expect(db.snapshot('whatsappTemplate')[0].providerStatus).toBe('pending');

    const retry = await svc.process(batch());
    expect(retry).toMatchObject({ processed: 3, duplicates: 1 }); // message = duplicate; template, echo, contact applied
    expect(db.snapshot('message').map((m) => m.providerMessageId).sort()).toEqual(['wamid.E1', 'wamid.IN1']);
    expect(db.snapshot('whatsappTemplate')[0].providerStatus).toBe('approved');
    expect(db.snapshot('conversation').find((c) => c.customerId === db.snapshot('customer').find((u) => u.phoneE164 === '+919855500001')!.id)!.unreadCount).toBe(1); // not 2

    expect(await svc.process(batch())).toMatchObject({ processed: 0, duplicates: 4 });
    expect(db.snapshot('message')).toHaveLength(2);
    expect(db.snapshot('auditLog')).toHaveLength(1);
  });
});

describe('messages, statuses, echoes and history keep their idempotency', () => {
  it('inbound message: a retry is a duplicate and does not double the unread count', async () => {
    const { db, svc } = setup();
    expect(await svc.process(ev(customerMessage()))).toMatchObject({ processed: 1 });
    expect(await svc.process(ev(customerMessage()))).toMatchObject({ processed: 0, duplicates: 1 });
    expect(db.snapshot('message')).toHaveLength(1);
    expect(db.snapshot('conversation')[0].unreadCount).toBe(1);
  });

  it('status: replays are duplicates and a late earlier status never regresses a later one', async () => {
    const { db, svc } = setup({ extra: { message: [{ id: 'm-1', agencyId: AG, providerMessageId: 'wamid.S1', direction: 'outbound', status: 'submitted' }] } });
    await svc.process(ev(statusEvent('wamid.S1', 'delivered')));
    expect(db.snapshot('message')[0].status).toBe('delivered');
    expect(await svc.process(ev(statusEvent('wamid.S1', 'delivered')))).toMatchObject({ processed: 0, duplicates: 1 });
    await svc.process(ev(statusEvent('wamid.S1', 'sent'))); // arrives late
    expect(db.snapshot('message')[0].status).toBe('delivered');
  });

  it('echo: a retry is a duplicate', async () => {
    const { db, svc } = setup();
    expect(await svc.process(ev(echoEvent()))).toMatchObject({ processed: 1 });
    expect(await svc.process(ev(echoEvent()))).toMatchObject({ processed: 0, duplicates: 1 });
    expect(db.snapshot('message')).toHaveLength(1);
    expect(db.snapshot('message')[0]).toMatchObject({ direction: 'outbound', status: 'sent' });
  });

  it('history: a retried chunk adds nothing, and old messages open no service window and raise no unread', async () => {
    const { db, svc } = setup();
    expect(await svc.process(ev(historyChunk()))).toMatchObject({ processed: 2, duplicates: 0 });
    expect(await svc.process(ev(historyChunk()))).toMatchObject({ processed: 0, duplicates: 2 });
    expect(db.snapshot('message')).toHaveLength(2);
    const conv = db.snapshot('conversation')[0];
    expect(conv.unreadCount ?? 0).toBe(0);
    expect(Date.now() - new Date(conv.lastInboundAt).getTime()).toBeGreaterThan(24 * 3600 * 1000);
  });
});

describe('a declined history share does not hide a meaningful error', () => {
  const lastError = (db: FakeDb) => db.snapshot('whatsappAccount')[0].lastErrorCode;
  it('records history:2593109 on an account with no error', async () => {
    const { db, svc } = setup();
    await svc.process(ev(historyDeclined()));
    expect(lastError(db)).toBe('history:2593109');
  });
  it.each(['190', 'PARTNER_REMOVED', 'APP_UNRECOGNISED', 'DISABLED_UPDATE'])('leaves an existing %s error alone', async (code) => {
    const { db, svc } = setup({ account: { lastErrorCode: code, lastErrorAt: new Date('2026-01-01') } });
    await svc.process(ev(historyDeclined()));
    expect(lastError(db)).toBe(code);
    expect(db.snapshot('whatsappAccount')[0].lastErrorAt).toEqual(new Date('2026-01-01'));
  });
  it('may refresh an older history note', async () => {
    const { db, svc } = setup({ account: { lastErrorCode: 'history:2593109', lastErrorAt: new Date('2026-01-01') } });
    await svc.process(ev(historyDeclined()));
    expect(lastError(db)).toBe('history:2593109');
    expect(new Date(db.snapshot('whatsappAccount')[0].lastErrorAt).getTime()).toBeGreaterThan(new Date('2026-01-01').getTime());
  });
});
