import { WhatsappAccountService } from './whatsapp-account.service';

// creds() is what carries "which Meta app issued this token" into app-specific operations (e.g. template-header uploads).
describe('WhatsappAccountService.creds', () => {
  const svc = new WhatsappAccountService({} as any, {} as any);
  const row = { phoneNumberId: 'PN1', wabaId: 'W1', credentialSecretRef: null };

  it('a legacy / manual account (NULL metaAppId) carries no app id, so the primary app is used', () => {
    expect(svc.creds({ ...row, metaAppId: null }).appId).toBeUndefined();
    expect(svc.creds(row).appId).toBeUndefined();
  });
  it('an Embedded Signup account carries its own app id', () => {
    expect(svc.creds({ ...row, metaAppId: 'SIGNUP_APP' }).appId).toBe('SIGNUP_APP');
  });
  it('does not invent a token when none is stored', () => {
    expect(svc.creds({ ...row, metaAppId: 'SIGNUP_APP' }).token).toBeUndefined();
  });
});
