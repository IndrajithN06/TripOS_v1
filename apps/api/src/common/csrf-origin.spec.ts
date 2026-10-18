import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { resetConfigForTests } from '../config/config';
import { CsrfGuard } from './auth';

// The browser sends an Origin header on every POST/PATCH; the API accepts exactly one origin: APP_URL. These tests pin that rule so
// the pilot's HTTPS web origin can be configured with confidence (APP_URL must equal the origin the page is opened from).
const ENV = { DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789', APP_URL: 'https://web.example.test' };
const KEYS = Object.keys(ENV);
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; });
beforeEach(() => { Object.assign(process.env, ENV); resetConfigForTests(); });
afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetConfigForTests(); });

const guard = new CsrfGuard(new Reflector());
const ctx = (method: string, headers: Record<string, string>, path = '/agency/whatsapp/embedded/start') => ({
  switchToHttp: () => ({ getRequest: () => ({ method, headers, path }) }), getHandler: () => () => undefined, getClass: () => class {},
}) as any;
const post = (origin?: string, csrf = '1') => () => guard.canActivate(ctx('POST', { ...(csrf ? { 'x-tripos-csrf': csrf } : {}), ...(origin ? { origin } : {}) }));

describe('CSRF origin rule (exact match with APP_URL)', () => {
  it('accepts a POST whose Origin is exactly APP_URL', () => { expect(post('https://web.example.test')()).toBe(true); });
  it('rejects every other origin, including the old localhost one', () => {
    for (const o of ['http://localhost:3100', 'https://other.example.test', 'http://web.example.test', 'https://web.example.test:8443', 'https://web.example.test/', 'https://evil.test']) expect(post(o)).toThrow(ForbiddenException);
  });
  it('still requires the custom CSRF header', () => { expect(post('https://web.example.test', '')).toThrow(/CSRF header/); });
  it('does not apply to GETs', () => { expect(guard.canActivate(ctx('GET', { origin: 'https://evil.test' }))).toBe(true); });
  it('a trailing slash in APP_URL would block every legitimate POST: the preflight rejects it', () => {
    process.env.APP_URL = 'https://web.example.test/'; resetConfigForTests();
    expect(post('https://web.example.test')).toThrow(ForbiddenException); // the browser never sends a trailing slash
  });
});
