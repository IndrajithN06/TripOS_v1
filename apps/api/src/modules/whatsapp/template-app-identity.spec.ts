import { readFileSync } from 'fs';
import { join } from 'path';
import { encryptSecret } from '../../common/crypto';
import { resetConfigForTests } from '../../config/config';
import { CloudWhatsApp } from '../../providers/whatsapp/whatsapp';
import { WhatsappAccountService } from './whatsapp-account.service';

// Template-header uploads must run on the Meta app that issued the account's token. The chain is: account row -> creds() -> provider.
// Mocked HTTP only; throwaway secrets.
const ENV = {
  DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789', WHATSAPP_PROVIDER: 'cloud',
  WHATSAPP_API_BASE_URL: 'https://graph.test/v99.0', WHATSAPP_APP_ID: 'APP_PRIMARY', WHATSAPP_APP_SECRET: 'secret-primary', WHATSAPP_VERIFY_TOKEN: 'verify-primary',
  WHATSAPP_SIGNUP_APP_ID: 'APP_SIGNUP', WHATSAPP_SIGNUP_APP_SECRET: 'secret-signup', WHATSAPP_SIGNUP_VERIFY_TOKEN: 'verify-signup',
};
const KEYS = Object.keys(ENV);
const saved: Record<string, string | undefined> = {};
let fetchMock: jest.SpyInstance;
const reply = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; });
beforeEach(() => { Object.assign(process.env, ENV); resetConfigForTests(); fetchMock = jest.spyOn(global, 'fetch'); });
afterEach(() => fetchMock.mockRestore());
afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetConfigForTests(); });

const svc = new WhatsappAccountService({} as any, {} as any);
const row = (metaAppId: string | null) => ({ phoneNumberId: 'PN1', wabaId: 'W1', credentialSecretRef: encryptSecret('account-token'), metaAppId });
const file = { data: Buffer.from('12345'), mimeType: 'image/png', filename: 'x.png' };
const uploadFor = async (metaAppId: string | null) => {
  fetchMock.mockReturnValueOnce(reply({ id: 'upload:1' })).mockReturnValueOnce(reply({ h: '4::handle' }));
  await new CloudWhatsApp().uploadTemplateExample(svc.creds(row(metaAppId)), file);
  return { url: String(fetchMock.mock.calls[0][0]), auth: (fetchMock.mock.calls[0][1] as any).headers.Authorization };
};

describe('template-header upload app identity, from the stored account row', () => {
  it('a legacy / manual account (NULL metaAppId) uploads on the PRIMARY app, with its own token', async () => {
    const r = await uploadFor(null);
    expect(r.url).toContain('/APP_PRIMARY/uploads?');
    expect(r.auth).toBe('Bearer account-token');
  });
  it('an Embedded Signup account uploads on the SIGNUP app', async () => {
    expect((await uploadFor('APP_SIGNUP')).url).toContain('/APP_SIGNUP/uploads?');
  });
  it('an account whose app is not configured is refused before any Meta call', async () => {
    await expect(new CloudWhatsApp().uploadTemplateExample(svc.creds(row('APP_ROTATED_AWAY')), file)).rejects.toMatchObject({ code: 'unknown_app' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('wiring guard: the template service passes the FULL account row (with metaAppId) through creds()', () => {
  // TemplatesService.submit needs far more than a unit test should stub, so this guards the call site itself: if someone
  // replaces creds(account) with hand-built credentials, the app identity would be lost.
  const src = readFileSync(join(__dirname, '../templates/templates.service.ts'), 'utf8');
  it('loads the whole account row and derives upload credentials from it', () => {
    expect(src).toMatch(/const account = await this\.accounts\.load\(agencyId\);/);
    expect(src).toMatch(/const creds = this\.accounts\.creds\(account\);/);
    expect(src).toMatch(/this\.wa\.uploadTemplateExample\(creds,/);
  });
});
