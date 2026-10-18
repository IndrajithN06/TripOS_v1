import { accountAppKey, appIdForAccount } from './app-identity';

const two = { primaryAppId: 'APP_PRIMARY', signupAppId: 'APP_SIGNUP' };

describe('accountAppKey (which Meta app an account belongs to)', () => {
  it('treats a legacy / manual account (NULL metaAppId) as the primary app', () => {
    expect(accountAppKey(null, two)).toBe('primary');
    expect(accountAppKey(undefined, two)).toBe('primary');
    expect(accountAppKey('', two)).toBe('primary');
    // ...even when no primary app id is configured (the user's current .env has none)
    expect(accountAppKey(null, { signupAppId: 'APP_SIGNUP' })).toBe('primary');
    expect(accountAppKey(null, {})).toBe('primary');
  });
  it('maps an explicit app id to its own route', () => {
    expect(accountAppKey('APP_PRIMARY', two)).toBe('primary');
    expect(accountAppKey('APP_SIGNUP', two)).toBe('signup');
  });
  it('denies an app id it does not recognise, on both routes', () => {
    expect(accountAppKey('SOME_OLD_APP', two)).toBeNull();
    expect(accountAppKey('APP_SIGNUP', { primaryAppId: 'APP_PRIMARY' })).toBeNull(); // signup app no longer configured
    expect(accountAppKey('APP_SIGNUP', {})).toBeNull();
  });
  it('single-app setups (both ids equal) have only the primary route', () => {
    const same = { primaryAppId: 'ONE', signupAppId: 'ONE' };
    expect(accountAppKey('ONE', same)).toBe('primary');
    expect(accountAppKey(null, same)).toBe('primary');
  });
});

describe('appIdForAccount (app-specific operations such as the template-header upload session)', () => {
  it('uses the primary app for legacy accounts and the signup app for signup accounts, never the other', () => {
    expect(appIdForAccount(null, two)).toBe('APP_PRIMARY');
    expect(appIdForAccount('APP_SIGNUP', two)).toBe('APP_SIGNUP');
    expect(appIdForAccount('APP_PRIMARY', two)).toBe('APP_PRIMARY');
  });
  it('returns nothing for an unrecognised app, and nothing when no primary app is configured for a legacy account', () => {
    expect(appIdForAccount('SOME_OLD_APP', two)).toBeUndefined();
    expect(appIdForAccount(null, { signupAppId: 'APP_SIGNUP' })).toBeUndefined();
  });
});
