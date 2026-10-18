import { evaluatePreflight, parseConfigProblems, PreflightFacts, renderChecks, sanitizeProblem } from './preflight';

const ON_DISK = ['m1_init', 'm2_health', 'm3_templates', 'm4_embedded', 'm5_meta_app', 'm6_attempt_app'];
const base = (over: Partial<PreflightFacts> = {}, env: Partial<PreflightFacts['env']> = {}, db: Partial<NonNullable<PreflightFacts['db']>> | null = {}): PreflightFacts => ({
  configProblems: null,
  env: {
    provider: 'cloud', embeddedEnabled: false, primary: { appId: true, secret: true, verifyToken: true }, signup: { appId: false, secret: false, verifyToken: false, configId: false },
    singleApp: false, appUrl: 'http://localhost:3100', apiUrl: 'http://localhost:4100', graphVersion: 'v21.0', ...env,
  },
  db: db === null ? null : { target: 'localhost:5442/tripos', applied: ON_DISK, unfinished: [], hasMetaAppId: true, hasSignupAppId: true, liveEmbeddedAccounts: 0, unrecognisedAccounts: 0, ...db },
  migrationsOnDisk: ON_DISK,
  ...over,
});
const levels = (f: PreflightFacts, o?: { forEnable?: boolean }) => Object.fromEntries(evaluatePreflight(f, o).checks.map((c) => [c.id, c.level]));
const ready = { signup: { appId: true, secret: true, verifyToken: true, configId: true }, appUrl: 'https://web.example.test' };

describe('preflight: deploying this build with Embedded Signup OFF', () => {
  it('a migrated, primary-only setup is OK to deploy; the signup parts are warnings, not failures', () => {
    const r = evaluatePreflight(base());
    expect(r.ok).toBe(true);
    const l = levels(base());
    expect(l).toMatchObject({ config: 'PASS', primary: 'PASS', db: 'PASS', migrations: 'PASS', flag: 'PASS', 'signup-config': 'WARN', 'app-url': 'WARN' });
    expect(r.summary.fail).toBe(0);
  });
  it('FAILS when migrations are pending, and says which, before the API is restarted', () => {
    const f = base({}, {}, { applied: ON_DISK.slice(0, 4), hasMetaAppId: false, hasSignupAppId: false });
    const r = evaluatePreflight(f);
    expect(r.ok).toBe(false);
    const m = r.checks.find((c) => c.id === 'migrations')!;
    expect(m.level).toBe('FAIL');
    expect(m.detail).toContain('m5_meta_app');
    expect(m.detail).toContain('m6_attempt_app');
    expect(m.detail).toMatch(/backup/i);
  });
  it('FAILS on an unfinished/rolled-back migration, and when the database cannot be inspected', () => {
    expect(levels(base({}, {}, { unfinished: ['m5_meta_app'] })).migrations).toBe('FAIL');
    const r = evaluatePreflight(base({}, {}, null));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'db')!.level).toBe('FAIL');
  });
  it('FAILS on invalid configuration and lists the problems (the API would refuse to start)', () => {
    const r = evaluatePreflight(base({ configProblems: ['WHATSAPP_APP_ID is required whenever any WHATSAPP_SIGNUP_* value is set'] }));
    expect(r.ok).toBe(false);
    expect(r.checks[0]).toMatchObject({ id: 'config', level: 'FAIL' });
    expect(r.checks[0].detail).toContain('WHATSAPP_APP_ID is required');
  });
  it('FAILS on a partly configured signup app, naming exactly what is missing', () => {
    const r = evaluatePreflight(base({}, { signup: { appId: true, secret: false, verifyToken: false, configId: false } }));
    const c = r.checks.find((x) => x.id === 'signup-config')!;
    expect(c.level).toBe('FAIL');
    expect(c.detail).toContain('WHATSAPP_SIGNUP_APP_SECRET');
    expect(c.detail).toContain('WHATSAPP_SIGNUP_VERIFY_TOKEN');
    expect(c.detail).not.toContain('WHATSAPP_SIGNUP_APP_ID,');
  });
  it('requires the original app id once signup values are set', () => {
    expect(levels(base({}, { ...ready, primary: { appId: false, secret: true, verifyToken: true } }))['primary-app-id']).toBe('FAIL');
  });
  it('FAILS when a connected account belongs to an app that is not configured here (its events would get 503)', () => {
    const r = evaluatePreflight(base({}, {}, { unrecognisedAccounts: 2 }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'app-identities')!.title).toMatch(/2 WhatsApp account/);
  });
  it('skips the identity check when the column does not exist yet (the migration check already fails)', () => {
    expect(levels(base({}, {}, { unrecognisedAccounts: null, hasMetaAppId: false }))['app-identities']).toBeUndefined();
  });
  it('warns, never silently passes, when the provider is not cloud', () => {
    expect(levels(base({}, { provider: 'simulator' })).primary).toBe('WARN');
  });
});

describe('preflight: APP_URL must be a bare origin', () => {
  it.each([['https://web.example.test/'], ['https://web.example.test/app'], ['not a url'], [undefined]])('rejects %s (the API compares the Origin header exactly)', (appUrl) => {
    const l = levels(base({}, { appUrl: appUrl as string | undefined }));
    expect(l['app-url-shape']).toBe('FAIL');
  });
  it('accepts a bare origin, with or without a port', () => {
    expect(levels(base({}, { appUrl: 'https://web.example.test' }))['app-url-shape']).toBeUndefined();
    expect(levels(base({}, { appUrl: 'https://web.example.test:8443' }))['app-url-shape']).toBeUndefined();
  });
});

describe('preflight: readiness to ENABLE Embedded Signup (--enable)', () => {
  it('turns the signup warnings into failures: nothing configured, localhost origin', () => {
    const r = evaluatePreflight(base(), { forEnable: true });
    expect(r.ok).toBe(false);
    expect(levels(base(), { forEnable: true })).toMatchObject({ 'signup-config': 'FAIL', 'config-id': 'FAIL', 'app-url': 'FAIL' });
  });
  it('passes when two-app signup is fully configured over a public HTTPS origin and everything is migrated', () => {
    const r = evaluatePreflight(base({}, ready), { forEnable: true });
    expect(r.checks.filter((c) => c.level !== 'PASS')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(levels(base({}, ready))['signup-route']).toBe('PASS');
  });
  it('single-app mode is supported and explains that the signup route answers 404', () => {
    const r = evaluatePreflight(base({}, { ...ready, singleApp: true }), { forEnable: true });
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.id === 'signup-route')!.title).toMatch(/404 in single-app mode/);
  });
  it('treats localhost and plain http as not good enough for the popup', () => {
    for (const appUrl of ['http://localhost:3100', 'https://localhost:3100', 'http://web.example.test']) expect(levels(base({}, { ...ready, appUrl }), { forEnable: true })['app-url']).toBe('FAIL');
  });
  it('with the flag already ON, an incomplete signup config or a non-HTTPS origin is a failure even without --enable', () => {
    const l = levels(base({}, { embeddedEnabled: true }));
    expect(l.flag).toBe('FAIL');
    expect(l['app-url']).toBe('FAIL');
  });
});

describe('preflight output never contains secret values', () => {
  it('redacts values that validation messages echo back', () => {
    expect(sanitizeProblem("WHATSAPP_PROVIDER: Invalid enum value. Expected 'simulator' | 'cloud', received 'sk-live-ABC123'")).not.toContain('sk-live-ABC123');
    expect(sanitizeProblem('X: bad, received "super-secret"')).toContain('received <redacted>');
  });
  it('parses the problem list out of a validation error message', () => {
    const msg = 'Unsafe or incomplete configuration:\n  - WHATSAPP_APP_SECRET is required when WHATSAPP_PROVIDER=cloud (set it in apps/api/.env)\n  - PORT: Expected number, received \'abc\'';
    expect(parseConfigProblems(msg)).toEqual(['WHATSAPP_APP_SECRET is required when WHATSAPP_PROVIDER=cloud (set it in apps/api/.env)', 'PORT: Expected number, received <redacted>']);
  });
  it('the rendered report carries names, hosts and counts only', () => {
    const text = renderChecks(evaluatePreflight(base({}, { ...ready, appUrl: 'https://user:pw@web.example.test' })).checks);
    expect(text).not.toMatch(/pw@|password|secret-value/i);
    expect(text).toContain('localhost:5442/tripos');
  });
});
