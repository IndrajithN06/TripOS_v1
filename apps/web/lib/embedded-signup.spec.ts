import { createSignupTracker, explainSignupError, isTrustedFacebookOrigin, parseSignupMessage, signupLaunchOptions } from './embedded-signup';

describe('isTrustedFacebookOrigin', () => {
  it.each(['https://www.facebook.com', 'https://web.facebook.com', 'https://business.facebook.com', 'https://facebook.com'])('trusts %s', (o) => expect(isTrustedFacebookOrigin(o)).toBe(true));
  it.each(['http://www.facebook.com', 'https://facebook.com.evil.test', 'https://evilfacebook.com', 'https://notfacebook.com', 'https://example.com', '', 'not a url', 'null'])('rejects %s', (o) => expect(isTrustedFacebookOrigin(o)).toBe(false));
});

describe('parseSignupMessage', () => {
  const ok = 'https://www.facebook.com';
  const finish = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', version: 3, data: { waba_id: 'W1', phone_number_id: 'P1', business_id: 'B1' } };
  it('reads a finish event given as a JSON string or an object', () => {
    const expected = { kind: 'finish', type: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', wabaId: 'W1', phoneNumberId: 'P1', businessId: 'B1' };
    expect(parseSignupMessage(ok, JSON.stringify(finish))).toEqual(expected);
    expect(parseSignupMessage(ok, finish)).toEqual(expected);
  });
  it('accepts the standard FINISH event and a finish that only carries the WABA', () => {
    expect(parseSignupMessage(ok, { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: 'W1', phone_number_id: 'P1' } })).toMatchObject({ kind: 'finish', type: 'FINISH' });
    expect(parseSignupMessage(ok, { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: 'W1' } })).toEqual({ kind: 'finish', type: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', wabaId: 'W1', phoneNumberId: undefined, businessId: undefined });
  });
  it('reads cancel and error events', () => {
    expect(parseSignupMessage(ok, { type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'PHONE_NUMBER_SETUP' } })).toEqual({ kind: 'cancel', step: 'PHONE_NUMBER_SETUP', errorMessage: undefined });
    expect(parseSignupMessage(ok, { type: 'WA_EMBEDDED_SIGNUP', event: 'ERROR', data: { error_message: 'boom' } })).toEqual({ kind: 'error', errorMessage: 'boom' });
  });
  it('ignores events from untrusted origins, other message types, WABA-only finishes and junk', () => {
    expect(parseSignupMessage('https://evil.test', finish)).toBeNull();
    expect(parseSignupMessage('https://facebook.com.evil.test', finish)).toBeNull();
    expect(parseSignupMessage(ok, { type: 'SOMETHING_ELSE', event: 'FINISH' })).toBeNull();
    expect(parseSignupMessage(ok, { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_ONLY_WABA', data: { waba_id: 'W1' } })).toBeNull();
    expect(parseSignupMessage(ok, 'not json')).toBeNull();
    expect(parseSignupMessage(ok, null)).toBeNull();
    expect(parseSignupMessage(ok, 42)).toBeNull();
  });
});

describe('createSignupTracker', () => {
  const finish = { kind: 'finish' as const, type: 'FINISH', wabaId: 'W', phoneNumberId: 'P' };
  const make = () => { const ready: any[] = [], aborted: string[] = []; return { ready, aborted, t: createSignupTracker((r) => ready.push(r), (m) => aborted.push(m)) }; };

  it('fires once when the code arrives after the finish event', () => {
    const { ready, t } = make();
    t.setMessage(finish); expect(ready).toHaveLength(0);
    t.setCode('c1'); expect(ready).toEqual([{ code: 'c1', finish }]);
    t.setCode('c2'); t.setMessage(finish); expect(ready).toHaveLength(1);
  });
  it('fires once when the finish event arrives after the code', () => {
    const { ready, t } = make();
    t.setCode('c1'); t.setMessage(finish);
    expect(ready).toEqual([{ code: 'c1', finish }]);
  });
  it('never fires with only one half, and aborts on cancel or error', () => {
    const a = make(); a.t.setCode('c1'); expect(a.ready).toHaveLength(0);
    const b = make(); b.t.setMessage({ kind: 'cancel', step: 'X' }); b.t.setCode('c1'); b.t.setMessage(finish);
    expect(b.ready).toHaveLength(0); expect(b.aborted).toHaveLength(1);
    const c = make(); c.t.setMessage({ kind: 'error', errorMessage: 'boom' }); expect(c.aborted).toEqual(['boom']);
  });
  it('reports a closed window when login ends without a code, but not after a code was received', () => {
    const a = make(); a.t.loginClosedWithoutCode(); expect(a.aborted).toHaveLength(1);
    const b = make(); b.t.setCode('c1'); b.t.loginClosedWithoutCode(); expect(b.aborted).toHaveLength(0);
  });
});

describe('explainSignupError', () => {
  it('explains the safety stops in plain language and falls back to the server text', () => {
    expect(explainSignupError('whatsapp_already_connected', 'x')).toMatch(/nothing was changed/i);
    expect(explainSignupError('not_coexistence', 'x')).toMatch(/not linked to the WhatsApp Business app/);
    expect(explainSignupError('unknown_code', 'server says so')).toBe('server says so');
  });
});

describe('signupLaunchOptions (FB.login options)', () => {
  it('asks Meta for WhatsApp Business app onboarding (Coexistence) with session info v3, keeping setup: {}', () => {
    expect(signupLaunchOptions('CFG1')).toEqual({
      config_id: 'CFG1',
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
    });
  });
  it('uses exactly the configuration id it is given and never a hard-coded one', () => {
    expect(signupLaunchOptions('A').config_id).toBe('A');
    expect(signupLaunchOptions('B').config_id).toBe('B');
  });
  it('returns a fresh object each time, so a caller cannot mutate a shared one', () => {
    const a = signupLaunchOptions('X'); a.extras.featureType = 'changed';
    expect(signupLaunchOptions('X').extras.featureType).toBe('whatsapp_business_app_onboarding');
  });
});
