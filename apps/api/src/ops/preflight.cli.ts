/**
 * Read-only readiness check. Run BEFORE restarting the API:
 *   npm run preflight -w @tripos/api              (deploying this build with Embedded Signup off)
 *   npm run preflight -w @tripos/api -- --enable  (before turning Embedded Signup on)
 * Exit code 1 if anything would block. It only reads: configuration is validated in memory, the database is inspected inside a
 * READ ONLY transaction, nothing is written, no network call to Meta, and no secret value is ever printed.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { validateConfig } from '../config/config'; // importing it loads apps/api/.env (existing variables are never overridden)
import { accountAppKey } from '../providers/whatsapp/app-identity';
import { evaluatePreflight, parseConfigProblems, PreflightFacts, renderChecks } from './preflight';

async function inspectDatabase(connectionString: string | undefined, apps: { primaryAppId?: string; signupAppId?: string }): Promise<PreflightFacts['db']> {
  if (!connectionString) return null;
  const u = new URL(connectionString);
  const target = `${u.hostname}:${u.port || '5432'}${u.pathname}`; // no username or password
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.bypass', 'on', true)"); // allowed in a read-only transaction; lets the app role see all rows
    const migs = await client.query('SELECT migration_name, finished_at IS NOT NULL AS done, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations');
    const cols = await client.query(`SELECT table_name, column_name FROM information_schema.columns WHERE (table_name = 'WhatsappAccount' AND column_name IN ('metaAppId','onboardingMethod')) OR (table_name = 'WhatsappSignupAttempt' AND column_name = 'signupAppId')`);
    const has = (t: string, c: string) => cols.rows.some((r) => r.table_name === t && r.column_name === c);
    const hasMetaAppId = has('WhatsappAccount', 'metaAppId'), hasSignupAppId = has('WhatsappSignupAttempt', 'signupAppId');
    let live = 0, unrecognised: number | null = null;
    if (has('WhatsappAccount', 'onboardingMethod')) live = (await client.query(`SELECT count(*)::int AS n FROM "WhatsappAccount" WHERE "onboardingMethod" = 'embedded' AND "connectionStatus" <> 'disconnected'`)).rows[0].n;
    if (hasMetaAppId) {
      const ids = await client.query('SELECT DISTINCT "metaAppId" FROM "WhatsappAccount" WHERE "metaAppId" IS NOT NULL AND "connectionStatus" <> \'disconnected\'');
      const bad = new Set(ids.rows.map((r) => r.metaAppId as string).filter((id) => accountAppKey(id, apps) === null));
      unrecognised = bad.size === 0 ? 0 : (await client.query('SELECT count(*)::int AS n FROM "WhatsappAccount" WHERE "metaAppId" = ANY($1) AND "connectionStatus" <> \'disconnected\'', [[...bad]])).rows[0].n;
    }
    await client.query('ROLLBACK');
    return {
      target, applied: migs.rows.filter((r) => r.done && !r.rolled_back).map((r) => r.migration_name),
      unfinished: migs.rows.filter((r) => !r.done || r.rolled_back).map((r) => r.migration_name), hasMetaAppId, hasSignupAppId, liveEmbeddedAccounts: live, unrecognisedAccounts: unrecognised,
    };
  } catch { return null; } finally { await client.end().catch(() => undefined); }
}

async function main() {
  const forEnable = process.argv.includes('--enable');
  const e = process.env;
  let configProblems: string[] | null = null;
  try { validateConfig(e); } catch (err) { configProblems = parseConfigProblems((err as Error).message); if (!configProblems.length) configProblems = ['Configuration could not be validated']; }

  const apps = { primaryAppId: e.WHATSAPP_APP_ID || undefined, signupAppId: e.WHATSAPP_SIGNUP_APP_ID || undefined };
  const migrationsOnDisk = readdirSync(join(__dirname, '../../prisma/migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const facts: PreflightFacts = {
    configProblems,
    env: {
      provider: e.WHATSAPP_PROVIDER, embeddedEnabled: e.WHATSAPP_EMBEDDED_SIGNUP_ENABLED === 'true',
      primary: { appId: !!e.WHATSAPP_APP_ID, secret: !!e.WHATSAPP_APP_SECRET, verifyToken: !!e.WHATSAPP_VERIFY_TOKEN },
      signup: { appId: !!e.WHATSAPP_SIGNUP_APP_ID, secret: !!e.WHATSAPP_SIGNUP_APP_SECRET, verifyToken: !!e.WHATSAPP_SIGNUP_VERIFY_TOKEN, configId: !!e.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID },
      singleApp: !!apps.primaryAppId && apps.primaryAppId === apps.signupAppId,
      appUrl: e.APP_URL, apiUrl: e.API_URL, graphVersion: /\/(v\d+\.\d+)\/?$/.exec(e.WHATSAPP_API_BASE_URL ?? '')?.[1],
    },
    db: await inspectDatabase(e.DATABASE_MIGRATE_URL || e.DATABASE_URL, apps),
    migrationsOnDisk,
  };
  const r = evaluatePreflight(facts, { forEnable });
  console.log(`TripOS preflight (${forEnable ? 'readiness to ENABLE Embedded Signup' : 'readiness to deploy with Embedded Signup as configured'})\n`);
  console.log(renderChecks(r.checks));
  console.log(`\n${r.summary.pass} passed, ${r.summary.warn} warning(s), ${r.summary.fail} failure(s) -> ${r.ok ? 'OK' : 'NOT READY'}`);
  process.exit(r.ok ? 0 : 1);
}
void main();
