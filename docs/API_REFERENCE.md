# API Reference

Base URL (local): `http://localhost:4100`. The web app calls the API through its own origin at `/api/*` (same-origin proxy), so cookies are first-party.

## Conventions
- **Auth:** httpOnly cookie `tripos_session` set by `POST /auth/login`. Sessions are re-validated against the database on every request.
- **CSRF:** every non-GET request (except the webhook) must send header `x-tripos-csrf: 1`; if an `Origin` header is present it must equal `APP_URL`.
- **Tenant:** never sent by the client. It is derived from the signed-in user. Unknown or foreign IDs return `404`.
- **Roles:** `SA` Super Admin, `AA` Agency Admin, `S` Sales. "Any agency" = AA or S.
- **Money:** decimal strings with two decimals (`"20400.00"`). Inputs accept strings or numbers with at most 2 decimals.
- **Times:** ISO-8601 UTC in and out; the UI renders them in the agency timezone.
- **Errors:** `{ "error": { "code", "message", "issues?" } }`. Common codes: `validation_error` (400), `duration_required` (400), `unauthenticated` (401), `forbidden` / `csrf` (403), `not_found` (404), `conflict` / `immutable` / `version_sent` (409), `pricing_error` (422). Production responses never include stack traces.
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
| GET | `/me` | any | user, agency (name, colour, signed logo URL), permissions, environment flags (simulator, storage) |
| POST | `/auth/mfa/setup` | any | returns secret and otpauth URL |
| POST | `/auth/mfa/enable` | any | `{code}` |

## Platform (Super Admin)
| Method | Path | Notes |
|---|---|---|
| POST | `/platform/agencies` | `{name, slug, adminName, adminEmail, plan?, aiMonthlyLimit?, timezone?}`; in non-production returns `inviteUrl` |
| GET | `/platform/agencies` | `search`, `status`; includes usage counts |
| PATCH | `/platform/agencies/:id` | `status` (active/suspended), `name`, `plan`; suspension is immediate |
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
| GET/PATCH | `/agency/settings` | `salesVisibility`, tax (`taxEnabled`, `taxRatePercent`, `taxMode`), `quoteValidityDays` |
| GET | `/agency/audit` | latest 100 audit entries |
| GET | `/agency/whatsapp` | connection view (never the token): `connectionStatus` (connecting/connected/degraded/disconnected), `statusReason`, quality rating, messaging limit tier, display-name status, `webhookSubscribed`, `lastWebhookAt`, `lastCheckedAt`, `lastErrorCode` |
| POST | `/agency/whatsapp/connect` | simulator: `{displayName}`; cloud: also `wabaId`, `phoneNumberId`, `accessToken`. Cloud mode verifies the token, subscribes the webhook, then stores the token encrypted; any failure stores nothing. `409` if the number or WABA belongs to another agency. |
| POST | `/agency/whatsapp/refresh` | re-check the number's health now; returns the connection view |
| POST | `/agency/whatsapp/disconnect` | erases the stored credential; sends blocked, incoming events ignored |
| GET / POST / PATCH / DELETE | `/agency/whatsapp/templates[/:id]` | rich template builder (named variables, header media, buttons); see `WHATSAPP_TEMPLATES.md` for the full set including preview, duplicate, media upload, `send-template` and the public quote link |
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
| GET | `/customers` | `search` (name, email, phone digits), `page`, `pageSize`; each item has `conversations`, `quotes` (live quotes only) and `lastActivityAt`. Agency admin and sales; sales in "assigned" visibility see only customers linked to them (assigned chat, own quote, or created by them) |
| GET | `/customers/:id` | customer, their WhatsApp conversations and non-deleted quotes (same visibility rules); a hidden or other-agency customer is `404` |
| POST | `/customers` | manual create: `name`, `phone` (must include the country code; stored as `+digits`, the same form WhatsApp webhooks use, so a number is never duplicated; `409 customer_exists`), optional `email`, `notes` |
| PATCH | `/customers/:id` | edit `name`, `email`, `notes` only (the phone is immutable); `null`/empty clears email and notes; audit records field names, never values |
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
| DELETE | `/quotes/:id` | **soft delete** (body: optional `reason`, max 500 chars, kept in the audit log only). Agency admin: any quote in the agency; sales: only quotes they own (`403` otherwise). Missing, other-agency, hidden-from-you or already-deleted quotes are all `404 not_found`; `409 quote_sending` while a send is running. The quote disappears from lists, search, detail, preview/PDF, the inbox panel, the dashboard and analytics; the customer's `/q/<token>` link and PDF stop working; queued retries do nothing. Versions, delivery records, messages, files and audit history are kept and the quote number is never reused. No restore endpoint in V1. |
| POST | `/quotes/:id/follow-up` | `{followUpAt|null}` |
| POST | `/quotes/:id/duplicate` | new quote number, version 1 |

**Trip duration (outstation).** An outstation trip is priced by its days (minimum km per day x days, and driver batta per day), so the server never guesses one. Every request that prices or saves a quote (`POST /quotes/calculate`, `POST /quotes`, `PATCH /quotes/:id/draft`, `POST /quotes/:id/versions`, and `POST /quotes/:id/duplicate`, which creates a quote) uses: an explicit `trip.days` (1-60) if given; otherwise the days derived from `trip.returnAt` (elapsed time from `pickupAt` in 24-hour blocks, rounded up, at least 1; the quote form uses the same rule); with neither it returns **`400 duration_required`** and nothing is priced, created or changed (no quote number is used). Previously the server silently used 1 day. Local packages (`local_8h_80km`, `local_4h_40km`) are priced by hours and km and are never affected. Reading a stored quote or version never recomputes anything, so older quotes stay viewable; a legacy outstation version stored without a duration can be duplicated or re-quoted once a `days` or `returnAt` is supplied.

Draft body (`POST /quotes`, `PATCH .../draft`, `POST /quotes/calculate`): `trip{tripType, pickupAt, returnAt?, pickupLocation, destinations[], itinerary?, passengers, days? (outstation: days or returnAt required), hours?, km?, minKmMode?, dailyKm?[]}`, `vehicleTypeId`, `overrides{}`, `extraCharges[{label,amount,taxable}]`, `discount{type:amount|percent,value}`, `includeDriverBatta`, `inclusions/exclusions/notes/terms`, `imageAssetIds[]`, `expiryAt?`.

## Inbox (any agency; subject to the Sales visibility policy)
| Method | Path | Notes |
|---|---|---|
| GET | `/inbox/conversations` | `search`, `filter` (all, unread, new, active, waiting, resolved, quoted; `open`, `closed`, `mine` and `unassigned` still work). Each item has `workflow` (`new`, `active`, `waiting` or `resolved`, derived from messages) beside the stored `status`; the response also carries `salesVisibility` (`all` or `assigned`). Optional `focus=<conversationId>` pins that chat to the top of the unfiltered, unsearched first page (used when a customer or quotation links to its chat, so an older chat is still shown); it follows the same visibility rule as the list, so a chat the caller may not see is never added |
| GET | `/inbox/conversations/:id` | `workflow`, stored `status`, `salesVisibility`; the customer (name, phone, email, internal `notes`, `since`) with `customerHistory` (`otherConversations`, `quotes`, `acceptedQuotes`, limited to what the caller may see); the assignee; internal notes; the chat's quotes, each with `status`, `destination`, `total`, `versionNumber`, `createdAt`, `followUpAt` and `followUpOverdue` (the dashboard's rule: an open, unexpired quote whose follow-up date has passed); 24h-window state (`windowOpen`, `windowExpiresAt`); `sendBlock` (`null`, or `{code, message}` explaining why a free-form text cannot be sent now: `window_closed` or `whatsapp_not_connected`); `chargesNotice` |
| GET | `/inbox/conversations/:id/messages` | `limit`, `before` |
| POST | `/inbox/conversations/:id/messages` | `{type:'text',text}` or `{type:'template',templateId,variables[]}`, optional `idempotencyKey` |
| GET | `/inbox/conversations/:id/starter-templates` | The five built-in TripOS message starters (Quotation Ready, Quote Follow-up, Booking Confirmation, Payment Reminder, Upcoming Trip Reminder) with their fields, plus `windowOpen`, `sendBlock` and a neutral `notice`. Read-only; same visibility rule as the conversation |
| POST | `/inbox/conversations/:id/starter-templates/:key/render` | `{values?}` (the agent's own entries). Returns the filled `text`, `missing[]` fields and per-field `auto` flags. Sends and stores nothing; the agent edits the text and sends it through the text path above |
| POST | `/inbox/conversations/:id/messages/:messageId/retry` | failed text only |
| POST | `/inbox/conversations/:id/resolve` | the one manual workflow action: marks the chat resolved (stored `closed`). Idempotent and audited. A new customer message reopens it |
| POST | `/inbox/conversations/:id/read` | clears unread |
| POST | `/inbox/conversations/:id/notes` | internal, never sent |
| PATCH | `/inbox/conversations/:id` | `assignedUserId` (must be an active user of this agency), `status`. Kept for agencies that use assigned-only visibility and for compatibility; the inbox UI does not use `status` |

**Conversation workflow (no manual status).** The stored `Conversation.status` keeps its three values (`open`, `pending`, `closed`), so no migration was needed. The four states shown to staff come from it plus one fact, whether the agency has ever answered the chat (an outbound message the provider accepted): **new** = open and never answered; **active** = open and answered before; **waiting** = pending; **resolved** = closed.

| Event | Stored status |
|---|---|
| Customer sends a message (a first message creates the chat) | `open` (reopens a waiting or resolved chat) |
| An employee's reply is accepted by the provider | `pending`, unless a customer message arrived after that reply was created |
| A message typed in the WhatsApp Business app (coexistence echo) | `pending`, under the same rule |
| `POST /inbox/conversations/:id/resolve` | `closed` |
| A failed send, a rejected send, or a background retry (no user) | unchanged |

Sending a quotation moves the chat to waiting like any reply, but never changes the quotation's own status (quote status and conversation status are separate), and the 24-hour window is separate too. Imported history never changes the status.

**Free-form text and the service window.** A free-form text is accepted only while the conversation's last *inbound* message is less than 24 hours old (exactly 24 hours is closed; our own messages never extend it). Otherwise the API returns `400 window_closed`, and a disconnected number returns `400 whatsapp_not_connected` (checked first, with the stored reason). Outside the window only an approved Meta template can be sent; a template that is not `approved` returns `400 template_not_approved`, and nothing is ever sent as a text instead. The check is made on the server on every send, and `sendBlock` on the conversation only mirrors it for the UI.

**Built-in starters are not Meta templates.** They are shared wording defined in code (`inbox/starter-messages.ts`), identical for every agency, never submitted to Meta and never treated as approved. Booking reference, departure date and amount due are always entered by the agent (V1 holds no booking or payment data); customer, agency and the conversation's latest quotation fill the rest. A value that cannot be filled is listed in `missing` and left as `{{name}}`, never guessed. Meta may charge for messages sent; TripOS neither bills nor estimates it.

## Dashboard (any agency)
| Method | Path | Notes |
|---|---|---|
| GET | `/dashboard?from&to` | headline counts, failure alerts |
| GET | `/dashboard/analytics?from&to` | KPIs with previous-period comparison, daily series, funnel, status split, top vehicles, heatmap |

## Development-only (`/dev/*`, 404 in production and with the real WhatsApp provider)
`POST /dev/simulator/inbound`, `/status`, `/fail-next`, `/template-decision`; `POST /dev/jobs/tick`; `GET /dev/emails`.
