# Technical Architecture (as implemented)

Modular monolith, npm workspaces.

```
apps/api          NestJS (TypeScript) REST API + in-process worker
apps/web          Next.js 15 (App Router) staff UI; proxies /api/* to the API (same-origin cookies)
packages/pricing  Pure decimal pricing library (no I/O, clock or globals)
docker-compose.yml  PostgreSQL 16 (port 5442) for local development
```

## Tenancy: two independent layers
1. **Application:** the tenant (`agencyId`) comes only from the authenticated user's DB row; request bodies/params never supply it. Every query filters by it.
2. **PostgreSQL RLS (`FORCE ROW LEVEL SECURITY`) on every tenant table.** The API connects as a non-superuser role. All data access goes through `Db.tenant(agencyId, fn)`, a transaction that sets `app.agency_id`, or `Db.system(fn)` for trusted platform code (login, webhook tenant resolution by `phone_number_id`, platform console). Even an unfiltered query returns only the current tenant's rows (tested).

## Data integrity in the database
- `numeric(18,2)` for money; CHECK constraints reject negatives.
- A trigger makes a `QuoteVersion` with `sentAt` immutable (only delivery `status` may change) and freezes its images.
- Tenant-scoped uniqueness (`quoteNumber`, customer phone, vehicle name, message idempotency/provider id).
- Audit log is append-only for the app role (UPDATE/DELETE revoked).

## Auth and security
Email/password (bcrypt), JWT in an httpOnly SameSite=Lax cookie, session revalidated against the DB on every request (disable/suspend/role change is immediate). CSRF: required `x-tripos-csrf` header plus Origin check. Throttling on login/invite. Helmet. Webhook HMAC (`X-Hub-Signature-256`) verification on the raw body. Uploads: magic-byte sniffing (JPEG/PNG only), 5 MB cap. Provider tokens AES-256-GCM encrypted at rest. TOTP MFA endpoints exist; production blocks Super Admin use until MFA is enrolled. Errors never leak stack traces in production.

## Provider adapters (`apps/api/src/providers`)
| Interface | Local | Production |
|---|---|---|
| `StorageProvider` | local disk + HMAC-signed URLs | S3-compatible (S3/R2/MinIO), presigned URLs |
| `WhatsAppProvider` | `SimulatorWhatsApp` (flagged `simulated`, failure injection) | `CloudWhatsApp` (Meta Cloud API) |
| `AiProvider` | `MockAi` (deterministic), `DisabledAi` | `OpenAiProvider` |
| `EmailProvider` | `ConsoleEmail` | `ResendEmail` |

Selected by env; `validateConfig` refuses unsafe production combinations (mock/simulator/local storage/default secrets) unless the explicit `ALLOW_MOCK_PROVIDERS_IN_PRODUCTION=true` is set.

## Messaging flow
Inbound webhook: verify signature, resolve tenant from `phone_number_id`, dedupe (`WebhookEvent` unique key + unique provider id), customer/conversation upsert, message. Statuses only move forward; a provider `failed` on a quote item turns it into a retryable partial failure. Outbound: record, provider call, record result, idempotent per key; 24h service-window and approved-template rules are enforced before calling the provider.

## Background jobs
Postgres-backed queue (`Job`, `SKIP LOCKED`, backoff, max attempts) behind `JobsService`. Used for automatic retry of failed quote items and a periodic expiry sweep. Chosen over Redis/BullMQ to avoid extra infrastructure in V1 (DECISIONS D-4); the service is the seam to swap.

## Realtime
Short polling (4 s) in the inbox. SSE/WebSocket is not implemented (DECISIONS D-5).

## Testing
Unit (pricing, config safety, crypto, webhook parsing/signature) and API e2e against a dedicated `tripos_test` database (isolation, permissions, vehicles, enquiry, quotes, versioning, delivery/retry, templates, AI, dashboard).
