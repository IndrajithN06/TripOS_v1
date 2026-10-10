import { createHmac } from 'crypto';
import { validateConfig, resetConfigForTests } from './config';
import { sniffImage } from '../common/assets';
import { CloudWhatsApp, parseCloudPayload } from '../providers/whatsapp/whatsapp';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { renderTemplate } from '../modules/inbox/outbound.service';

const devEnv = {
  NODE_ENV: 'development', DATABASE_URL: 'postgresql://x', SESSION_SECRET: 'dev-only-session-secret-0123456789', APP_ENCRYPTION_KEY: 'dev-only-encryption-key-0123456789ab',
};
const goodProd = {
  NODE_ENV: 'production', APP_URL: 'https://app.example.com', API_URL: 'https://api.example.com', DATABASE_URL: 'postgresql://u:strongpw@db.example.com/tripos',
  SESSION_SECRET: 'x'.repeat(48), APP_ENCRYPTION_KEY: 'y'.repeat(48), STORAGE_PROVIDER: 's3', STORAGE_BUCKET: 'b', STORAGE_REGION: 'r', STORAGE_ACCESS_KEY_ID: 'k', STORAGE_SECRET_ACCESS_KEY: 's',
  STORAGE_SIGNING_SECRET: 'prod-signing-secret', WHATSAPP_PROVIDER: 'cloud', WHATSAPP_APP_SECRET: 'sec', WHATSAPP_VERIFY_TOKEN: 'ver', AI_PROVIDER: 'disabled', EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'key',
};

describe('Scenario 11: production configuration safety', () => {
  it('accepts a complete, safe production configuration', () => {
    expect(validateConfig(goodProd).isProd).toBe(true);
  });
  it('accepts development defaults outside production', () => {
    expect(validateConfig(devEnv).WHATSAPP_PROVIDER).toBe('simulator');
  });
  it.each([
    ['dev session secret', { SESSION_SECRET: 'dev-only-session-secret-0123456789abcdef' }, /SESSION_SECRET/],
    ['short encryption key', { APP_ENCRYPTION_KEY: 'short-but-sixteen!!' }, /APP_ENCRYPTION_KEY/],
    ['local disk storage', { STORAGE_PROVIDER: 'local' }, /STORAGE_PROVIDER/],
    ['simulated WhatsApp', { WHATSAPP_PROVIDER: 'simulator' }, /WHATSAPP_PROVIDER/],
    ['mock AI', { AI_PROVIDER: 'mock' }, /AI_PROVIDER/],
    ['console email', { EMAIL_PROVIDER: 'console' }, /EMAIL_PROVIDER/],
    ['dev database password', { DATABASE_URL: 'postgresql://tripos_app:tripos_app_dev_only@localhost/x' }, /development credentials/],
    ['http app url', { APP_URL: 'http://app.example.com' }, /APP_URL/],
    ['default signing secret', { STORAGE_SIGNING_SECRET: 'dev-only-storage-signing-secret' }, /STORAGE_SIGNING_SECRET/],
    ['missing webhook secret', { WHATSAPP_APP_SECRET: '' }, /WHATSAPP_APP_SECRET/],
    ['openai without key', { AI_PROVIDER: 'openai' }, /AI_API_KEY/],
  ])('refuses %s in production instead of falling back silently', (_n, override, re) => {
    expect(() => validateConfig({ ...goodProd, ...override } as any)).toThrow(re);
  });
  it('reports every problem at once', () => {
    try { validateConfig({ ...goodProd, STORAGE_PROVIDER: 'local', WHATSAPP_PROVIDER: 'simulator', AI_PROVIDER: 'mock' } as any); fail('should throw'); }
    catch (e) { expect((e as Error).message).toMatch(/STORAGE_PROVIDER[\s\S]*WHATSAPP_PROVIDER[\s\S]*AI_PROVIDER/); }
  });
  it('mock providers in production need an explicit opt-in flag', () => {
    expect(() => validateConfig({ ...goodProd, WHATSAPP_PROVIDER: 'simulator', ALLOW_MOCK_PROVIDERS_IN_PRODUCTION: 'true' } as any)).not.toThrow();
  });
  it('requires core settings', () => {
    expect(() => validateConfig({ NODE_ENV: 'development' })).toThrow(/DATABASE_URL/);
  });
  afterAll(resetConfigForTests);
});

describe('security helpers', () => {
  beforeAll(() => { process.env.APP_ENCRYPTION_KEY = 'unit-test-encryption-key-0123456789'; process.env.SESSION_SECRET = 'unit-test-session-secret-0123456789'; process.env.DATABASE_URL = 'x'; process.env.WHATSAPP_APP_SECRET = 'whsec'; resetConfigForTests(); });
  afterAll(resetConfigForTests);

  it('encrypts secrets reversibly with authenticated encryption', () => {
    const blob = encryptSecret('EAAG-token-123');
    expect(blob).not.toContain('EAAG');
    expect(decryptSecret(blob)).toBe('EAAG-token-123');
    const tampered = Buffer.from(blob, 'base64'); tampered[tampered.length - 1] ^= 1;
    expect(() => decryptSecret(tampered.toString('base64'))).toThrow();
  });
  it('sniffs real image types and rejects disguised files', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImage(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });
  it('verifies Meta webhook signatures with the app secret', () => {
    const wa = new CloudWhatsApp();
    const body = Buffer.from('{"entry":[]}');
    const good = 'sha256=' + createHmac('sha256', 'whsec').update(body).digest('hex');
    expect(wa.verifySignature(body, good)).toBe(true);
    expect(wa.verifySignature(body, 'sha256=' + '0'.repeat(64))).toBe(false);
    expect(wa.verifySignature(Buffer.from('{"entry":[1]}'), good)).toBe(false);
    expect(wa.verifySignature(body, undefined)).toBe(false);
  });
  it('parses Meta webhook payloads into messages and statuses', () => {
    const ev = parseCloudPayload({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PN1' }, contacts: [{ wa_id: '919800000000', profile: { name: 'Asha' } }],
      messages: [{ id: 'wamid.1', from: '919800000000', timestamp: '1700000000', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'look' } }],
      statuses: [{ id: 'wamid.2', status: 'failed', timestamp: '1700000001', errors: [{ code: 131026, title: 'Undeliverable' }] }] } }] }] });
    expect(ev[0]).toMatchObject({ kind: 'message', phoneNumberId: 'PN1', from: '+919800000000', name: 'Asha', type: 'image', text: 'look', mediaId: 'MEDIA1' });
    expect(ev[1]).toMatchObject({ kind: 'status', status: 'failed', errorCode: '131026' });
  });
  it('renders template variables', () => {
    expect(renderTemplate('Hi {{1}}, quote {{2}}', ['Asha', 'Q-1'])).toBe('Hi Asha, quote Q-1');
  });
});
