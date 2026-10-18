/**
 * Deployment / Embedded Signup readiness evaluation. PURE: it takes facts (gathered read-only by preflight.cli.ts) and returns a
 * list of checks. It never sees a secret value, only booleans, names and non-secret identifiers, so its output is safe to paste.
 *
 * Levels: FAIL blocks deploying this build; WARN is fine for deploying with Embedded Signup OFF but blocks enabling it
 * (`forEnable` turns those WARNs into FAILs).
 */
export type Level = 'PASS' | 'WARN' | 'FAIL';
export interface Check { id: string; level: Level; title: string; detail?: string }

export interface PreflightFacts {
  /** null = configuration loaded fine; otherwise the problems reported by validateConfig (already sanitised). */
  configProblems: string[] | null;
  env: {
    provider?: string;
    embeddedEnabled: boolean;
    primary: { appId: boolean; secret: boolean; verifyToken: boolean };
    signup: { appId: boolean; secret: boolean; verifyToken: boolean; configId: boolean };
    /** Both app ids set and equal (the explicitly supported single-app setup). */
    singleApp: boolean;
    appUrl?: string;
    apiUrl?: string;
    graphVersion?: string;
  };
  /** null = the database could not be inspected. */
  db: null | {
    target: string; // host:port/database, never credentials
    applied: string[];
    unfinished: string[];
    hasMetaAppId: boolean;
    hasSignupAppId: boolean;
    liveEmbeddedAccounts: number;
    unrecognisedAccounts: number | null; // null when the column does not exist yet
  };
  migrationsOnDisk: string[];
}

/** Zod messages can echo a received value for enum fields; never let that reach output. */
export function sanitizeProblem(line: string): string {
  return line.replace(/received\s+'[^']*'/gi, 'received <redacted>').replace(/received\s+"[^"]*"/gi, 'received <redacted>').trim();
}
export function parseConfigProblems(message: string): string[] {
  return message.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => sanitizeProblem(l.slice(2)));
}

const hostOf = (u?: string) => { try { return new URL(u ?? '').host; } catch { return u ? '(not a valid URL)' : '(unset)'; } };
const isHttpsPublic = (u?: string) => { try { const x = new URL(u ?? ''); return x.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(x.hostname); } catch { return false; } };
const isPlainOrigin = (u?: string) => { try { return new URL(u ?? '').origin === u; } catch { return false; } };

export function evaluatePreflight(f: PreflightFacts, opts: { forEnable?: boolean } = {}) {
  const checks: Check[] = [];
  const add = (id: string, level: Level, title: string, detail?: string) => checks.push({ id, level, title, detail });
  const gate = (level: Level): Level => (level === 'WARN' && opts.forEnable ? 'FAIL' : level); // enabling needs the WARNs fixed too

  // 1. configuration
  if (f.configProblems === null) add('config', 'PASS', 'Configuration loads and validates');
  else add('config', 'FAIL', `Configuration is invalid (${f.configProblems.length} problem${f.configProblems.length === 1 ? '' : 's'}); the API would refuse to start`, f.configProblems.map((p) => `- ${p}`).join('\n'));

  // 2. the existing (primary) integration
  if (f.env.provider === 'cloud') add('primary', f.env.primary.secret && f.env.primary.verifyToken ? 'PASS' : 'FAIL', 'Original Cloud API app', `provider=cloud, secret ${f.env.primary.secret ? 'set' : 'MISSING'}, verify token ${f.env.primary.verifyToken ? 'set' : 'MISSING'}, app id ${f.env.primary.appId ? 'set' : 'not set'}`);
  else add('primary', 'WARN', `WhatsApp provider is "${f.env.provider ?? 'unset'}", not cloud`, 'Real messaging uses the cloud provider.');

  // 3. database + migrations
  const pending = f.migrationsOnDisk.filter((m) => !(f.db?.applied ?? []).includes(m));
  if (!f.db) add('db', 'FAIL', 'Database could not be inspected', 'Check DATABASE_URL / DATABASE_MIGRATE_URL and that Postgres is running.');
  else {
    add('db', 'PASS', `Database reachable: ${f.db.target}`);
    if (f.db.unfinished.length) add('migrations', 'FAIL', 'A migration is recorded as unfinished or rolled back', f.db.unfinished.join(', '));
    else if (pending.length || !f.db.hasMetaAppId || !f.db.hasSignupAppId) {
      add('migrations', 'FAIL', `${pending.length} migration(s) not applied; an API built from this release would fail on WhatsApp queries`, `Apply before restarting: ${pending.join(', ') || '(columns missing)'}. Take a backup first (docs/PRODUCTION_DEPLOYMENT.md).`);
    } else add('migrations', 'PASS', `All ${f.migrationsOnDisk.length} migrations applied; metaAppId and signupAppId columns present`);
    if (f.db.unrecognisedAccounts !== null) {
      if (f.db.unrecognisedAccounts > 0) add('app-identities', 'FAIL', `${f.db.unrecognisedAccounts} WhatsApp account(s) belong to a Meta app that is not configured here`, 'Their webhook events would be refused (HTTP 503). Restore the app settings or reconnect the account.');
      else add('app-identities', 'PASS', 'Every connected account maps to a configured Meta app');
    }
    add('live-embedded', 'PASS', `${f.db.liveEmbeddedAccounts} live Embedded Signup account(s) in this database`);
  }

  // 4. Embedded Signup configuration (the second Meta app)
  const s = f.env.signup;
  const set = [s.appId, s.secret, s.verifyToken].filter(Boolean).length;
  if (set === 0) {
    add('signup-config', gate('WARN'), 'Embedded Signup app is not configured', 'WHATSAPP_SIGNUP_APP_ID, WHATSAPP_SIGNUP_APP_SECRET and WHATSAPP_SIGNUP_VERIFY_TOKEN are all unset: /webhooks/whatsapp/signup answers 404 and signup cannot be enabled.');
  } else if (set < 3) {
    add('signup-config', 'FAIL', 'Embedded Signup app is only partly configured', `Set all three WHATSAPP_SIGNUP_* values or none (missing: ${[!s.appId && 'WHATSAPP_SIGNUP_APP_ID', !s.secret && 'WHATSAPP_SIGNUP_APP_SECRET', !s.verifyToken && 'WHATSAPP_SIGNUP_VERIFY_TOKEN'].filter(Boolean).join(', ')}).`);
  } else {
    add('signup-config', 'PASS', f.env.singleApp ? 'Embedded Signup app configured (single-app mode: same app as the original)' : 'Embedded Signup app configured (two-app mode)');
    if (!f.env.primary.appId) add('primary-app-id', 'FAIL', 'WHATSAPP_APP_ID (the original app) is required when signup values are set');
    if (f.env.singleApp) add('signup-route', 'PASS', '/webhooks/whatsapp/signup answers 404 in single-app mode; the original callback receives everything');
    else add('signup-route', 'PASS', '/webhooks/whatsapp/signup is live (own verify token and signing secret)');
  }
  if (!s.configId) add('config-id', gate('WARN'), 'WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID is not set', 'Required before the popup can start.');
  else add('config-id', 'PASS', 'Embedded Signup configuration id is set');

  // 5. the web origin used by the popup
  if (!isPlainOrigin(f.env.appUrl)) add('app-url-shape', 'FAIL', 'APP_URL must be a bare origin (scheme://host[:port]) with no path or trailing slash', 'The API compares the browser Origin to APP_URL exactly; a trailing slash would block every POST and PATCH.');
  if (isHttpsPublic(f.env.appUrl)) add('app-url', 'PASS', `APP_URL is a public HTTPS origin (${hostOf(f.env.appUrl)})`);
  else add('app-url', f.env.embeddedEnabled ? 'FAIL' : gate('WARN'), `APP_URL is not a public HTTPS origin (${hostOf(f.env.appUrl)})`, 'Meta supports only HTTPS domains for the Embedded Signup popup. Serve the web app over HTTPS (tunnel or host) and set APP_URL to that exact origin; the UI must then be opened from that origin.');
  add('api-url', 'PASS', `API_URL host: ${hostOf(f.env.apiUrl)}`);

  // 6. the feature flag
  if (f.env.embeddedEnabled) {
    if (set < 3 || !s.configId) add('flag', 'FAIL', 'WHATSAPP_EMBEDDED_SIGNUP_ENABLED=true but the signup configuration is incomplete');
    else add('flag', 'PASS', 'Embedded Signup is ENABLED');
  } else add('flag', 'PASS', 'Embedded Signup is disabled (expected until every prerequisite passes)');

  if (!/^v\d+\.\d+$/.test(f.env.graphVersion ?? '')) add('graph-version', 'WARN', 'Graph API version could not be read from WHATSAPP_API_BASE_URL');

  const ok = !checks.some((c) => c.level === 'FAIL');
  return { checks, ok, summary: { fail: checks.filter((c) => c.level === 'FAIL').length, warn: checks.filter((c) => c.level === 'WARN').length, pass: checks.filter((c) => c.level === 'PASS').length } };
}

export function renderChecks(checks: Check[]): string {
  return checks.map((c) => `[${c.level}] ${c.title}${c.detail ? '\n       ' + c.detail.replace(/\n/g, '\n       ') : ''}`).join('\n');
}
