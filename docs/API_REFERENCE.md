# API Reference

Base URL (local): `http://localhost:4100`. The web app calls the API through its own origin at `/api/*` (same-origin proxy), so cookies are first-party.

## Conventions
- **Auth:** httpOnly cookie `tripos_session` set by `POST /auth/login`. Sessions are re-validated against the database on every request.
- **CSRF:** every non-GET request (except the webhook) must send header `x-tripos-csrf: 1`; if an `Origin` header is present it must equal `APP_URL`.
- **Tenant:** never sent by the client. It is derived from the signed-in user. Unknown or foreign IDs return `404`.
- **Roles:** `SA` Super Admin, `AA` Agency Admin, `S` Sales. "Any agency" = AA or S.
- **Money:** decimal strings with two decimals (`"20400.00"`). Inputs accept strings or numbers with at most 2 decimals.
- **Times:** ISO-8601 UTC in and out; the UI renders them in the agency timezone.
- **Errors:** `{ "error": { "code", "message", "issues?" } }`. Common codes: `validation_error` (400), `unauthenticated` (401), `forbidden` / `csrf` (403), `not_found` (404), `conflict` / `immutable` / `version_sent` (409), `pricing_error` (422), `ai_unavailable` (503). Production responses never include stack traces.
- **Rate limits:** login and accept-invite are limited to 10 per minute per client; general limit 600 per minute.
- **Pagination:** list endpoints take `page` and `pageSize` (max 100).

## Public
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/health/ready` | readiness: database and storage checks |
| POST | `/auth/login` | `{email, password, mfaCode?}`; returns `{mfaRequired:true}` if MFA is enrolled and no code was sent |
| POST | `/auth/accept-invite` | `{token, password(10+)}`; single use; activates the user (and the agency on first admin) |
| GET | `/webhooks/whatsapp` | Meta verification handshake (`hub.*` parameters) |
| POST | `/webhooks/whatsapp` | Meta events. HMAC-SHA256 signature required. Tenant resolved from `phone_number_id`. Deduplicated. |
| GET | `/media/local?key&exp&sig` | signed file delivery (local storage only) |

## Session
| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/auth/logout` | any | |
| GET | `/me` | any | user, agency (name, colour, signed logo URL), permissions, environment flags (simulator, AI, storage) |
| POST | `/auth/mfa/setup` | any | returns secret and otpauth URL |
| POST | `/auth/mfa/enable` | any | `{code}` |

## Platform (Super Admin)
| Method | Path | Notes |
|---|---|---|
| POST | `/platform/agencies` | `{name, slug, adminName, adminEmail, plan?, aiMonthlyLimit?, timezone?}`; in non-production returns `inviteUrl` |
| GET | `/platform/agencies` | `search`, `status`; includes usage counts |
| PATCH | `/platform/agencies/:id` | `status` (active/suspended), `name`, `aiEnabled`, `aiMonthlyLimit`, `plan`; suspension is immediate |
| POST | `/platform/agencies/:id/reinvite-admin` | new set-password link for the first admin |
| POST | `/platform/support-access` | `{agencyId, reason(10+), minutes(5-60)}`; audited |
| GET | `/platform/support/:id/conversations` | conversation metadata only, needs a live grant |
| GET/PATCH | `/platform/settings` | `{aiKillSwitch}` |
| GET | `/platform/errors` | failed background jobs |

## Agency administration (AA unless noted)
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/agency/users` | invite `{name,email,role: SALES|AGENCY_ADMIN, canOverrideRates}` |
| PATCH | `/agency/users/:id` | name, status (active/disabled), role, `canOverrideRates`; revokes sessions on disable or role change; cannot lock yourself out |
| POST | `/agency/users/:id/reinvite` | resend invite or issue password-reset link |
| GET (any) / PATCH | `/agency/branding` | colour, tagline, contact, footer, terms, inclusions, exclusions |
| POST | `/agency/branding/logo` | multipart `file` (JPEG/PNG, 5 MB) |
| GET/PATCH | `/agency/settings` | `salesVisibility`, tax (`taxEnabled`, `taxRatePercent`, `taxMode`), `quoteValidityDays`, `aiEnabled`; GET includes AI usage |
| GET | `/agency/audit` | latest 100 audit entries |
| GET | `/agency/whatsapp` | connection view (never the token): `connectionStatus` (connecting/connected/degraded/disconnected), `statusReason`, quality rating, messaging limit tier, display-name status, `webhookSubscribed`, `lastWebhookAt`, `lastCheckedAt`, `lastErrorCode` |
| POST | `/agency/whatsapp/connect` | simulator: `{displayName}`; cloud: also `wabaId`, `phoneNumberId`, `accessToken`. Cloud mode verifies the token, subscribes the webhook, then stores the token encrypted; any failure stores nothing. `409` if the number or WABA belongs to another agency. |
| POST | `/agency/whatsapp/refresh` | re-check the number's health now; returns the connection view |
| POST | `/agency/whatsapp/disconnect` | erases the stored credential; sends blocked, incoming events ignored |
| GET (any) / POST | `/agency/whatsapp/templates` | local drafts; variable count validated; list includes `rejectedReason`, `providerTemplateId` |
| POST | `/agency/whatsapp/templates/sync` | pull all templates and statuses from the provider |
| POST | `/agency/whatsapp/templates/:id/submit` | submit a draft or rejected template to Meta (simulator: marks `submitted`); stores the provider's status, never "approved" |

## Vehicle types (read: any, write: AA)
| Method | Path | Notes |
|---|---|---|
| GET | `/agency/vehicle-types` | `includeArchived=true`; each item has current rate and signed image URLs |
| GET | `/agency/vehicle-types/:id` | |
| POST | `/agency/vehicle-types` | `{name, category, seats, description?, amenities[], rate{...}}` |
| PATCH | `/agency/vehicle-types/:id` | fields and/or `rate` (appends a new rate row, old rows kept as history) |
| POST | `/agency/vehicle-types/:id/archive` and `/restore` | |
| POST | `/agency/vehicle-types/:id/images` | multipart `file`, optional `caption`, `altText`; magic-byte validated |
| PUT | `/agency/vehicle-types/:id/images/order` | `{ids[]}` must list every image once |
| PATCH | `/agency/vehicle-types/:id/images/:imageId` | `caption`, `altText`, `isPrimary:true` |
| DELETE | `/agency/vehicle-types/:id/images/:imageId` | file kept if any quote version references it |

## Quotes (any agency)
| Method | Path | Notes |
|---|---|---|
| POST | `/quotes/calculate` | pricing preview, nothing saved; client-supplied totals are ignored |
| POST | `/quotes` | create draft v1 from `conversationId` or `customerId` |
| GET | `/quotes` | `search`, `status`, `conversationId`, `page`, `pageSize` |
| GET | `/quotes/:id` | header, all versions, send attempts |
| PATCH | `/quotes/:id/draft` | edit the current unsent version; `409 version_sent` if already sent |
| POST | `/quotes/:id/versions` | requote: new version from the sent one, optional changes; returns `diff` |
| GET | `/quotes/:id/diff?from&to` | total delta and changed lines |
| GET | `/quotes/:id/versions/:n/preview` | branded preview model with signed photo URLs |
| GET | `/quotes/:id/versions/:n/pdf` | stored PDF for sent versions, rendered for drafts |
| POST | `/quotes/:id/versions/:n/send` | text → PDF → photos; returns per-item result |
| POST | `/quotes/:id/versions/:n/retry` | resend only failed/pending items |
| POST | `/quotes/:id/status` | manual transitions (see Business Guide §5.7) |
| POST | `/quotes/:id/follow-up` | `{followUpAt|null}` |
| POST | `/quotes/:id/duplicate` | new quote number, version 1 |

Draft body (`POST /quotes`, `PATCH .../draft`, `POST /quotes/calculate`): `trip{tripType, pickupAt, returnAt?, pickupLocation, destinations[], itinerary?, passengers, days?, hours?, km?, minKmMode?, dailyKm?[]}`, `vehicleTypeId`, `overrides{}`, `extraCharges[{label,amount,taxable}]`, `discount{type:amount|percent,value}`, `includeDriverBatta`, `inclusions/exclusions/notes/terms`, `imageAssetIds[]`, `expiryAt?`.

## Inbox (any agency; subject to the Sales visibility policy)
| Method | Path | Notes |
|---|---|---|
| GET | `/inbox/conversations` | `search`, `filter` (all, unread, mine, unassigned, open, closed, quoted) |
| GET | `/inbox/conversations/:id` | customer, assignee, notes, quotes, 24h-window state, AI summary |
| GET | `/inbox/conversations/:id/messages` | `limit`, `before` |
| POST | `/inbox/conversations/:id/messages` | `{type:'text',text}` or `{type:'template',templateId,variables[]}`, optional `idempotencyKey` |
| POST | `/inbox/conversations/:id/messages/:messageId/retry` | failed text only |
| POST | `/inbox/conversations/:id/read` | clears unread |
| POST | `/inbox/conversations/:id/notes` | internal, never sent |
| PATCH | `/inbox/conversations/:id` | `assignedUserId` (must be an active user of this agency), `status` |
| POST | `/inbox/conversations/:id/ai/:feature` | `summary`, `reply-suggestions`, `extract`, `quote-draft`, `negotiation`; drafts only; 503 when unavailable |

## Dashboard (any agency)
| Method | Path | Notes |
|---|---|---|
| GET | `/dashboard?from&to` | headline counts, failure alerts |
| GET | `/dashboard/analytics?from&to` | KPIs with previous-period comparison, daily series, funnel, status split, top vehicles, heatmap |

## Development-only (`/dev/*`, 404 in production and with the real WhatsApp provider)
`POST /dev/simulator/inbound`, `/status`, `/fail-next`, `/template-decision`, `/ai-fail-next`; `POST /dev/jobs/tick`; `GET /dev/emails`.
