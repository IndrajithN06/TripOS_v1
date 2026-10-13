import { execSync } from 'child_process';
import { Client } from 'pg';

/** Creates (if needed) and migrates a dedicated test database so e2e runs never touch dev data. */
export default async function setup() {
  const admin = new Client({ connectionString: 'postgresql://tripos:tripos_dev_only@localhost:5442/postgres' });
  await admin.connect();
  const r = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'tripos_test'");
  if (!r.rowCount) await admin.query('CREATE DATABASE tripos_test');
  await admin.query('GRANT CONNECT ON DATABASE tripos_test TO tripos_app');
  await admin.end();
  execSync('npx prisma migrate deploy', {
    stdio: 'pipe', cwd: __dirname + '/..',
    env: { ...process.env, DATABASE_URL: 'postgresql://tripos_app:tripos_app_dev_only@localhost:5442/tripos_test', DATABASE_MIGRATE_URL: 'postgresql://tripos:tripos_dev_only@localhost:5442/tripos_test' },
  });
  // Start every run with an empty job queue: queued jobs left behind by earlier runs (this is a throwaway database)
  // would otherwise be picked up by the worker tick that some tests drive and make timing-dependent assertions flaky.
  const db = new Client({ connectionString: 'postgresql://tripos:tripos_dev_only@localhost:5442/tripos_test' });
  await db.connect();
  await db.query(`UPDATE "Job" SET status = 'done' WHERE status IN ('pending', 'running')`);
  await db.end();
}
