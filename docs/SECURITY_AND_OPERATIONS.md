# Security and Operations

## 1. Security controls (implemented)
| Area | Control | Where |
|---|---|---|
| Authentication | bcrypt password hashes; JWT in httpOnly, SameSite=Lax cookie (Secure in production); 12 h lifetime; TOTP MFA available; production blocks Super Admin features until MFA is enrolled | `modules/auth`, `common/auth.ts` |
| Session revocation | Every request re-reads the user and agency; disabling a user, changing role, resetting a password (`tokenVersion`) or suspending an agency takes effect immediately | `AuthGuard` |
| Authorisation | Role guards on every route; tenant derived from the user, never request input | `common/auth.ts` |
| Tenant isolation | App-level scoping **and** PostgreSQL RLS (`FORCE`) with a non-superuser runtime role | `db/db.service.ts`, `prisma/migrations/*_init` |
| CSRF | Required `x-tripos-csrf` header plus `Origin` check on every non-GET | `CsrfGuard` |
| Input validation | zod schemas on all request bodies; emails trimmed; money regex; enums | controllers |
| Brute force | 10 attempts/min on login and invite acceptance; generic "invalid email or password" | `ThrottlerModule` |
| Uploads | Real type detected from magic bytes (JPEG/PNG only), 5 MB cap, files stored under `agencies/<id>/...`, never served from a public bucket | `common/assets.ts` |
| Media access | Short-lived signed URLs (default 300 s); local signatures are HMAC; tampering returns 404 | storage providers |
| Secrets | Provider tokens AES-256-GCM encrypted at rest; invitation tokens stored hashed; no secret in browser bundles or logs | `common/crypto.ts` |
| Webhooks | HMAC-SHA256 over the raw body, constant-time compare; tenant from the trusted `phone_number_id`; event de-duplication | `webhooks` |
| Messaging safety | Idempotency keys; 24 h window and approved-template checks before any provider call | `outbound.service.ts` |
| Quote integrity | Totals only from the pricing library; DB trigger freezes sent versions (even against raw SQL) | `quotes.service.ts`, migration |
| AI safety | Server-side only; customer text passed as data; outputs sanitised and labelled drafts; per-agency limit; platform kill switch; usage logged | `ai.service.ts` |
| Support access | Time-limited, reasoned, audited grant; metadata only | `platform` |
| Audit | Append-only for the app role; logins, user/role changes, rate changes, quote events, settings, support access | `common/audit.ts` |
| Config safety | Startup fails on development secrets, local storage, simulator, mock AI, console email, non-HTTPS URLs in production | `config/config.ts` |
| Errors | Uniform envelope; stack traces only outside production | `common/errors.ts` |
| Headers | Helmet on the API; `X-Frame-Options: DENY`, `nosniff` on the web app | `main.ts`, `next.config.mjs` |

## 2. Known weaknesses and residual risk
- The Cloud, S3, OpenAI and Resend adapters are unverified live.
- Malware scanning of uploads is not implemented (type and size only).
- No per-tenant rate limiting; no IP allow-listing for platform routes.
- `app.bypass` is a session setting available to any SQL the app role runs; RLS protects against missing filters, not against SQL injection (the code uses parameterised queries only).
- Dependency audit not run; keep dependencies updated.
- Retention, consent and a privacy notice are undefined.
- Local development secrets are placeholders and must never reach production (the config check enforces this).

## 3. Secrets management
| Secret | Rotation impact |
|---|---|
| `SESSION_SECRET` | rotating signs everyone out |
| `APP_ENCRYPTION_KEY` | **do not rotate casually**: stored WhatsApp tokens become unreadable; re-encrypt first or have agencies reconnect |
| `STORAGE_SIGNING_SECRET` | invalidates outstanding local signed URLs |
| WhatsApp app secret / verify token | update in Meta and in the environment together |
| Database passwords | rotate the owner and app roles separately |
Keep production values in the host's secret manager; `.env` files are git-ignored.

## 4. Monitoring (to be wired up before real traffic)
- Uptime check on `GET /health/ready` (database and storage).
- Alert on rows in `Job` with `status='failed'` (also visible in the Super Admin console).
- Error tracking for API and web.
- Webhook 4xx/5xx rate and signature failures.
- AI spend via `AiUsage`.
- Send-failure counts (dashboard) and Meta quality rating.

## 5. Adding a tenant table (checklist)
1. Add the model with `agencyId @db.Uuid` and an index starting with it.
2. In the migration, enable and force RLS and add the policy:
```sql
ALTER TABLE "NewTable" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NewTable" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "NewTable"
  USING ("agencyId" = nullif(current_setting('app.agency_id', true), '')::uuid OR current_setting('app.bypass', true) = 'on')
  WITH CHECK ("agencyId" = nullif(current_setting('app.agency_id', true), '')::uuid OR current_setting('app.bypass', true) = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON "NewTable" TO tripos_app;
```
3. Access it only through `Db.tenant(agencyId, ...)`.
4. Add a cross-tenant test (read, write, list) to `test/isolation.e2e-spec.ts`.

## 6. Runbooks
**Webhook not arriving:** check the tunnel/URL is public and HTTPS; Meta callback URL and verify token; the `messages` field is subscribed; the API log for `bad_signature` (wrong app secret); `phone_number_id` matches `WhatsappAccount.phoneNumberId` (unknown ids are logged and ignored).

**Sends failing:** open the quote's version history for the item error; common causes are a closed 24 h window (`window_closed`), a revoked or expired token, or an unapproved template. Use **Retry failed items only**. Background retries run with backoff up to 4 attempts, then show under Super Admin → Operational errors.

**Stuck background jobs:** inspect `Job` rows (`status`, `lastError`, `runAt`); pending jobs run when the worker ticks (every 5 s); in development use `POST /dev/jobs/tick`.

**Suspected cross-tenant exposure:** suspend the affected agency, preserve the audit log, review `platform.support_*` entries, and run the isolation test suite against the deployed build.

**User cannot log in:** Settings → Team → Resend invite / Reset password; confirm status is not disabled and the agency is not suspended.

**Restore:** restore the latest snapshot into a scratch database, apply later migrations, verify row counts and a sample quote and PDF, then switch over. Practise before launch.

## 7. Routine operations
Rotate secrets on a schedule; review audit logs and failed jobs weekly; update dependencies and rerun `npm test` and `npm run test:e2e`; verify backups restore; review AI usage and agency limits; review Meta quality rating and template status.
