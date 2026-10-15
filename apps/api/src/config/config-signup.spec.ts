import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'dotenv';
import { accountAppKey } from '../providers/whatsapp/app-identity';
import { validateConfig } from './config';

const base = { DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789' };
const cloud = { ...base, WHATSAPP_PROVIDER: 'cloud', WHATSAPP_APP_SECRET: 'p-secret', WHATSAPP_VERIFY_TOKEN: 'p-verify' };
const trio = { WHATSAPP_SIGNUP_APP_ID: 'S_ID', WHATSAPP_SIGNUP_APP_SECRET: 's-secret', WHATSAPP_SIGNUP_VERIFY_TOKEN: 's-verify' };
const messageOf = (env: Record<string, string>) => { try { validateConfig(env); return ''; } catch (e) { return (e as Error).message; } };

describe('signup-app configuration edge cases (M2)', () => {
  it('a primary-only setup is unchanged: valid with or without WHATSAPP_APP_ID', () => {
    expect(() => validateConfig(cloud)).not.toThrow();
    expect(() => validateConfig({ ...cloud, WHATSAPP_APP_ID: 'P_ID' })).not.toThrow();
  });
  it('ANY signup value requires the primary WHATSAPP_APP_ID, flag on or off', () => {
    expect(messageOf({ ...cloud, ...trio })).toMatch(/WHATSAPP_APP_ID is required whenever any WHATSAPP_SIGNUP_\* value is set/);
    expect(messageOf({ ...cloud, WHATSAPP_SIGNUP_APP_ID: 'S_ID' })).toMatch(/WHATSAPP_APP_ID is required/);
    expect(messageOf({ ...cloud, ...trio, WHATSAPP_EMBEDDED_SIGNUP_ENABLED: 'true', WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: 'c' })).toMatch(/WHATSAPP_APP_ID is required/);
  });
  it('equal secrets are rejected when the primary app id is absent (cannot be a deliberate single-app setup)', () => {
    const msg = messageOf({ ...cloud, ...trio, WHATSAPP_SIGNUP_APP_SECRET: 'p-secret' });
    expect(msg).toMatch(/WHATSAPP_APP_ID is required/);
    expect(msg).not.toContain('p-secret');
  });
  it('different app ids must have different secrets, and the same app id the same secret', () => {
    expect(messageOf({ ...cloud, WHATSAPP_APP_ID: 'P_ID', ...trio, WHATSAPP_SIGNUP_APP_SECRET: 'p-secret' })).toMatch(/inconsistent/);
    expect(messageOf({ ...cloud, WHATSAPP_APP_ID: 'SAME', ...trio, WHATSAPP_SIGNUP_APP_ID: 'SAME' })).toMatch(/inconsistent/);
    expect(messageOf({ ...cloud, WHATSAPP_APP_ID: 'P_ID', ...trio })).toBe(''); // two genuinely different apps
  });
  it('the single-app setup is explicitly supported and every account then resolves to the PRIMARY route', () => {
    const env = { ...cloud, WHATSAPP_APP_ID: 'SAME', WHATSAPP_SIGNUP_APP_ID: 'SAME', WHATSAPP_SIGNUP_APP_SECRET: 'p-secret', WHATSAPP_SIGNUP_VERIFY_TOKEN: 's-verify' };
    const c = validateConfig(env);
    const apps = { primaryAppId: c.WHATSAPP_APP_ID, signupAppId: c.WHATSAPP_SIGNUP_APP_ID };
    expect(accountAppKey(null, apps)).toBe('primary');
    expect(accountAppKey('SAME', apps)).toBe('primary'); // an Embedded Signup account's webhooks arrive on the original callback
  });
  it('rejects placeholder or whitespace-padded values (e.g. copied from an example file)', () => {
    expect(messageOf({ ...cloud, WHATSAPP_APP_ID: 'P_ID', ...trio, WHATSAPP_SIGNUP_VERIFY_TOKEN: '<random>' })).toMatch(/WHATSAPP_SIGNUP_VERIFY_TOKEN looks like a placeholder/);
    expect(messageOf({ ...cloud, WHATSAPP_APP_ID: 'P_ID', ...trio, WHATSAPP_SIGNUP_APP_ID: ' S_ID' })).toMatch(/WHATSAPP_SIGNUP_APP_ID looks like a placeholder or has surrounding whitespace/);
  });
  it('still all-or-nothing, and the error never prints a value', () => {
    const msg = messageOf({ ...cloud, WHATSAPP_APP_ID: 'P_ID', WHATSAPP_SIGNUP_APP_SECRET: 'super-secret-value' });
    expect(msg).toMatch(/must be set together/);
    expect(msg).not.toContain('super-secret-value');
  });
});

describe('the example env files (M1)', () => {
  const read = (f: string) => parse(readFileSync(join(__dirname, '../..', f)));

  it('.env.production.example, copied as-is and filled with REAL values for the required settings only, passes validation (Embedded Signup stays off)', () => {
    const example = read('.env.production.example');
    // Nothing about the signup app is active in the example.
    for (const k of ['WHATSAPP_SIGNUP_APP_ID', 'WHATSAPP_SIGNUP_APP_SECRET', 'WHATSAPP_SIGNUP_VERIFY_TOKEN', 'WHATSAPP_WEBHOOK_MAX_BODY_BYTES']) expect(example[k]).toBeUndefined();
    expect(example.WHATSAPP_EMBEDDED_SIGNUP_ENABLED).toBe('false');
    const real = {
      DATABASE_URL: 'postgresql://app:Strong-pw-1@db.example.com:5432/tripos', DATABASE_MIGRATE_URL: 'postgresql://owner:Strong-pw-2@db.example.com:5432/tripos',
      SESSION_SECRET: 'x'.repeat(40), APP_ENCRYPTION_KEY: 'y'.repeat(40), STORAGE_SIGNING_SECRET: 'z'.repeat(40),
      APP_URL: 'https://app.example.com', API_URL: 'https://api.example.com', PUBLIC_QUOTE_BASE_URL: 'https://app.example.com',
      STORAGE_PROVIDER: 's3', STORAGE_BUCKET: 'bucket', STORAGE_REGION: 'ap-south-1', STORAGE_ACCESS_KEY_ID: 'AKIAEXAMPLE', STORAGE_SECRET_ACCESS_KEY: 'storage-secret',
      WHATSAPP_APP_ID: '1234567890', WHATSAPP_APP_SECRET: 'whatsapp-app-secret', WHATSAPP_VERIFY_TOKEN: 'real-verify-token',
      AI_PROVIDER: 'disabled', EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'email-key',
    };
    expect(messageOf({ ...example, ...real, NODE_ENV: 'production' })).toBe('');
  });
  it('.env.example (development) parses and validates with the signup app left commented out', () => {
    const example = read('.env.example');
    expect(example.WHATSAPP_SIGNUP_APP_ID).toBeUndefined();
    expect(messageOf({ ...example })).toBe('');
  });
});
