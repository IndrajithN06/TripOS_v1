# Production Deployment (PREPARED, NOT EXECUTED)

> **Nothing here has been run.** No production resource, domain, database, WhatsApp number or paid service has been created or changed. CI has no deploy job; `Dockerfile` is an unused artifact. Deployment happens only after the product owner's explicit approval.

## Prerequisites to obtain first (external)
| Item | Notes |
|---|---|
| Managed PostgreSQL 15+ | Two roles: **owner** (migrations) and **tripos_app** (runtime, `NOSUPERUSER NOBYPASSRLS`). Superusers bypass RLS, so never run the API as one. |
| Private S3-compatible bucket | Block all public access; app role needs get/put/delete on the bucket only. |
| Hosting for 2 processes | API (Node 22, runs the in-process worker) and Web (Next.js). Keep **one** API instance running the worker or accept that jobs are claimed with `SKIP LOCKED` (safe to scale). |
| Domain + HTTPS | App and API on the same site (e.g. `app.` / `api.`). Web proxies `/api/*` to the API via `API_INTERNAL_URL`. |
| Meta WhatsApp Business Platform | Meta developer app, **business verification**, WABA + phone number per agency (Embedded Signup), webhook subscription, message-template approvals. Lead times and review outcomes are Meta's. Alternatively a BSP (open decision). |
| OpenAI API key (optional) | `AI_PROVIDER=disabled` runs the product without AI. |
| Email provider (Resend) | Verified sending domain for invitations. |
| Secrets manager | Holds everything in `.env.production.example`. |

Costs depend on volume and provider pricing (Meta per-conversation fees, OpenAI tokens, managed Postgres, storage/egress, hosting, email). Obtain current price sheets; none are assumed here.

## Environment
Copy `apps/api/.env.production.example` into your secret manager. Startup **fails with a precise list** if a secret is a development default, storage is `local`, WhatsApp is `simulator`, AI is `mock`, or URLs are not https. Web needs only `API_INTERNAL_URL`. No secret may be placed in `NEXT_PUBLIC_*`.

## Procedure
1. **Backup** the database (snapshot) before any migration.
2. Build images: `docker build --target api -t tripos-api .` and `--target web -t tripos-web .`.
3. Run migrations deliberately, as the owner role: `DATABASE_MIGRATE_URL=... npx prisma migrate deploy` (from `apps/api`). Create the `tripos_app` role first and grant per `apps/api/prisma/migrations/*_init/migration.sql` (the grants run automatically if the role exists).
4. Deploy API; check `GET /health` and `GET /health/ready` (database + storage).
5. Deploy Web; sign-in smoke test.
6. Create the Super Admin out-of-band (SQL/one-off script with a strong password), sign in, **enrol MFA** (`POST /auth/mfa/setup` then `/auth/mfa/enable`); in production nothing else is usable for Super Admin until MFA is on.
7. Configure the Meta webhook: callback `https://api.example.com/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`, subscribe to `messages`. Connect an agency via Settings → WhatsApp (WABA ID, phone number ID, token).
8. Verify end to end with a staging number before any real customer number is connected.

## Rollback and recovery
- Application: redeploy the previous image tag.
- Database: migrations are forward-only. If a migration is bad, restore the pre-migration snapshot, or ship a forward-fix migration. Do not hand-edit applied migrations.
- Never rotate `APP_ENCRYPTION_KEY` without re-encrypting stored WhatsApp tokens (it would make them unreadable; agencies would reconnect).

## Backups and restore
Enable automated daily snapshots + point-in-time recovery; store bucket versioning. **Perform a restore test** into a scratch database before launch and record the result.

## Monitoring (to wire up)
Error tracking (e.g. Sentry), uptime on `/health/ready`, alerts on failed `Job` rows (visible in the Super Admin console), webhook 4xx/5xx rate, AI spend (`AiUsage`), send-failure counts (dashboard).

## Known gaps before real traffic
See `TESTING_AND_ACCEPTANCE.md` → "Not verified / limitations". The Meta Cloud, S3, OpenAI and Resend adapters are written but have **not** been exercised against the live services.
