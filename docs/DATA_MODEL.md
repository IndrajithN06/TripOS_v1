# Data Model

PostgreSQL 16, managed with Prisma migrations (`apps/api/prisma`). 24 tables and one enum (`Role`: SUPER_ADMIN, AGENCY_ADMIN, SALES). Identifiers are UUIDs. Money is `numeric(18,2)`. Timestamps are UTC and shown in the agency timezone.

## Isolation rules
- Every tenant table has `agencyId`. Row-level security (`FORCE`) restricts the runtime role to rows where `agencyId = current_setting('app.agency_id')`; trusted platform code uses `app.bypass`.
- `Agency` is isolated by its own `id`. `PlatformSetting` and `SupportAccessGrant` are platform-only and have no tenant policy (accessed only by system code).
- The runtime role (`tripos_app`) is `NOSUPERUSER NOBYPASSRLS`, and has `UPDATE`/`DELETE` revoked on `AuditLog`.

## Tables
### Tenancy and people
| Table | Purpose | Key fields / constraints |
|---|---|---|
| `Agency` | A tenant | `slug` unique; `status` setup_pending / active / suspended; `timezone`, `currency`; tax (`taxEnabled`, `taxRatePercent`, `taxMode`); `salesVisibility`; `quoteValidityDays`; `quoteSeq` (per-agency quote counter); AI (`aiEnabled`, `aiMonthlyLimit`) |
| `User` | Staff and platform users | `email` globally unique; `agencyId` null for Super Admin; `role`; `status` invited / active / disabled; `canOverrideRates`; `tokenVersion` (bumped to revoke sessions); `mfaSecret` (encrypted), `mfaEnabled` |
| `Invitation` | Set-password tokens | stores a SHA-256 **hash** of the token; `expiresAt` (72 h); `usedAt` (single use) |
| `AgencyBranding` | One row per agency | colour, tagline, contact details, footer, terms, default inclusions/exclusions, `logoAssetId` |
| `SupportAccessGrant` | Time-limited cross-tenant support access | `superAdminId`, `agencyId`, `reason`, `expiresAt` |
| `PlatformSetting` | Key/value platform flags | e.g. the AI kill switch |

### Customers and messaging
| Table | Purpose | Key fields / constraints |
|---|---|---|
| `WhatsappAccount` | An agency's connection | one per agency; `phoneNumberId` unique (tenant resolution for webhooks); `credentialSecretRef` = AES-256-GCM encrypted token; `mode` simulator / cloud |
| `Customer` | End customer | unique (`agencyId`, `phoneE164`) |
| `Conversation` | A chat | `status` open / pending / closed; `assignedUserId`; `lastInboundAt` (drives the 24 h window); `unreadCount`; AI `summary` |
| `ConversationNote` | Internal notes | never sent to customers |
| `Message` | Inbound and outbound | `direction`, `type`, `status` (queued/submitted/sent/delivered/read/failed/received), `providerMessageId`, `simulated`, `idempotencyKey`; unique (`agencyId`,`providerMessageId`) and (`agencyId`,`idempotencyKey`) |
| `WebhookEvent` | De-duplication ledger | unique (`agencyId`,`eventKey`) |
| `WhatsappTemplate` | Template drafts and provider state | `providerStatus` local_draft / submitted / pending / approved / rejected / paused; `variableSchema` |

### Catalogue
| Table | Purpose | Notes |
|---|---|---|
| `VehicleType` | Quotable vehicle category | unique (`agencyId`,`name`); `active=false` = archived (never deleted) |
| `VehicleRate` | Rate card rows | append-only history; the latest row by `effectiveAt` is current; CHECK constraints reject negative values |
| `Asset` | Stored files | `storageKey`, `mimeType`, `size`, `checksum`, `assetType` (vehicle_image, logo, quote_pdf, message_media) |
| `VehicleTypeImage` | Photos of a type | `sortOrder`, `isPrimary`, `caption`, `altText` |

### Quotes
| Table | Purpose | Notes |
|---|---|---|
| `Quote` | Header | unique (`agencyId`,`quoteNumber`); `status`; `currentVersionId`; `expiryAt`; `followUpAt`; `ownerUserId` |
| `QuoteVersion` | A priced snapshot | `trip` JSON, `rateSnapshot` JSON, `pricingInput` JSON (the editable inputs), `lines` JSON, `subtotal/discount/tax/total`, `termsSnapshot` JSON (branding and terms at that moment), `pdfAssetId`, `sentAt`; unique (`quoteId`,`versionNumber`). **A database trigger makes the row immutable once `sentAt` is set** (only `status` may change) and forbids deleting it. |
| `QuoteVersionImage` | Photos chosen for a version | frozen by trigger once the version is sent |
| `QuoteSendAttempt` | Per-item delivery (text, pdf, each image) | `status` pending / sent / failed, `attempts`, `lastError`, `messageId`; powers partial-delivery retry |

### Operations
| Table | Purpose |
|---|---|
| `AiUsage` | One row per AI call: feature, model, tokens, estimated cost, status |
| `AuditLog` | Append-only record of sensitive actions (`action`, `entityType`, `entityId`, `metadata`) |
| `Job` | Postgres-backed queue: `type`, `payload`, `status`, `attempts`, `maxAttempts`, `runAt`, `lastError` |

## Relationships (logical)
```
Agency 1─* User, Customer, VehicleType, Quote, Conversation, WhatsappTemplate, Asset
Agency 1─1 AgencyBranding, WhatsappAccount
Customer 1─* Conversation 1─* Message, ConversationNote
VehicleType 1─* VehicleRate, VehicleTypeImage ─1 Asset
Quote 1─* QuoteVersion 1─* QuoteVersionImage, QuoteSendAttempt ─? Message
Quote ─? Conversation, Customer, User(owner)
```
Foreign keys are logical (UUID columns plus indexed lookups); referential checks are enforced in application code inside tenant transactions. Adding database-level foreign keys is a roadmap hardening item.

## Derived definitions
- **Current rate card:** latest `VehicleRate` row by `effectiveAt` for the type.
- **Quote total:** only ever written from the pricing library's result.
- **Pipeline value:** sum of `QuoteVersion.total` for `Quote.currentVersionId` where the quote is sent/negotiating and not expired.
- **24 h window open:** `Conversation.lastInboundAt` is within 24 hours.

## Migrations
`apps/api/prisma/migrations/*_init` creates the schema, RLS policies, CHECK constraints, immutability triggers and role grants. It is forward-only: fix mistakes with a new migration or restore a snapshot. Apply with `npm run db:migrate` (owner role).
