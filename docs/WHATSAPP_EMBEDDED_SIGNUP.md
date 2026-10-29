# WhatsApp Embedded Signup v4 (coexistence)

Status: **implemented behind a feature flag (default off); tested only against a fake Meta. Not yet verified end to end against the real service.**
Two-Meta-app support (original Cloud API app + Embedded Signup app) is implemented in code; **migrations `20261015090000_whatsapp_account_meta_app_id` and `20261015100000_whatsapp_signup_attempt_app_id` exist but have NOT been applied to any database**, and the dashboard/HTTPS checks below have not been done.
Pilot target: an agency whose number is already on the WhatsApp Business app, which keeps working while TripOS also uses it ("coexistence").
Manual connection (paste WABA ID, phone number ID, token) is unchanged and remains the fallback.

## What it does
1. Admin opens Settings → WhatsApp → **Connect with Facebook** (only shown when the flag is on).
2. `POST /agency/whatsapp/embedded/start` creates a resumable attempt and returns a one-time `state` value (stored only as a hash).
3. The browser loads Meta's JS SDK and runs `FB.login` with the configuration id and the options from `signupLaunchOptions()` in `apps/web/lib/embedded-signup.ts` (`response_type: 'code'`, `override_default_response_type: true`, `extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' }`). `featureType` selects the WhatsApp Business app (coexistence) flow, and `sessionInfoVersion: '3'` selects the session-event format whose completion event is `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`. These options follow Meta's documentation but have not yet been verified against the real service.
4. The popup reports the connected account (`WA_EMBEDDED_SIGNUP` message event: `FINISH` or `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) and, via the `FB.login` callback, a one-time code.
5. `POST /agency/whatsapp/embedded/complete` (server side, agency taken from the session):
   1. checks attempt ownership, the `state` value and expiry; takes an atomic run lock;
   2. records the code's hash, then exchanges it (`GET /oauth/access_token` with the **signup app's** id and secret, `WHATSAPP_SIGNUP_APP_ID` / `WHATSAPP_SIGNUP_APP_SECRET`; never the original app's) and stores the token encrypted (AES-GCM) on the attempt together with the signup app id that issued it (`WhatsappSignupAttempt.signupAppId`);
   3. **verifies ownership**: the token must list the reported WABA's phone numbers and include the reported number; neither may belong to another agency; the number must report `is_on_biz_app: true`;
   4. subscribes the app to the WABA's webhooks and reads the number's health;
   5. commits in one transaction, **only if the agency has no live WhatsApp connection** and **only if the configured signup app is still the one that issued the token** (otherwise the attempt fails permanently, the token is erased and the admin starts again), recording that app id on the account; then erases the token from the attempt;
   6. best effort: requests contacts and history sync (`POST /{phone-number-id}/smb_app_data`) if the admin asked, and syncs templates.
6. Each step is recorded; a failure keeps the (encrypted) token so **Resume** needs no new code, unless the failure is final.

It never registers, migrates or deregisters a number, and never overwrites or disconnects an existing connection.

## Webhooks for coexistence numbers
| Field | Handling |
|---|---|
| `smb_message_echoes` | Message typed in the Business app → stored as an outbound message (`sent`, no TripOS user). Does not open the 24 h window. Edit/revoke echoes are acknowledged, not applied. |
| `history` | Imported once per message id; original timestamps kept; never raises unread or opens the window. A declined share (error `2593109`) is recorded on the account (`lastErrorCode = history:2593109`) without failing anything, **but only when no other error is recorded**: it never overwrites a meaningful one (an auth failure, `PARTNER_REMOVED`, `APP_UNRECOGNISED`, ...), and the next successful health check clears it like any other. |
| `smb_app_state_sync` | Added contacts become customers; existing names are kept; removals never delete data. |
| `account_update` / `PARTNER_REMOVED` | Embedded-Signup account → `disconnected`, credential erased. Manually connected account → `degraded`, credential kept. WABA is read from `waba_info.waba_id` (the entry id can be a partner business id). |
These three data fields are ignored for accounts that were not onboarded as coexistence numbers.

## Two Meta apps (design and security decisions)
TripOS can run **two** Meta apps side by side. The original Cloud API app is untouched; Embedded Signup uses its own app.

| | Primary app (existing) | Signup app (Embedded Signup v4) |
|---|---|---|
| Env names | `WHATSAPP_APP_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | `WHATSAPP_SIGNUP_APP_ID`, `WHATSAPP_SIGNUP_APP_SECRET`, `WHATSAPP_SIGNUP_VERIFY_TOKEN` (all three or none) |
| Webhook route | `/webhooks/whatsapp` (unchanged) | `/webhooks/whatsapp/signup` (404 until its secret and verify token are set) |
| Used for | existing connections, template-header uploads for those accounts | popup (`FB.init`), authorization-code exchange, webhooks of accounts it issued |
| `WhatsappAccount.metaAppId` | `NULL` (every pre-existing and manually connected account) | the signup app id, written **only** when an Embedded Signup account is committed |

Decisions:
- **Each route validates exactly one app.** `X-Hub-Signature-256` is checked with the secret of the route's own app (`verifyMetaSignature`, constant-time, strict header format). A signature that happens to match the *other* app's secret is rejected. There is no "either secret" path.
- **Why separate routes:** Meta's webhook payload carries no app id, and anything read from the body is unauthenticated. The route decides the app, so nothing is guessed.
- **Account-to-app isolation:** after the account is looked up, an event is applied only if the account belongs to the route's app (`NULL` = primary). A leaked secret of one app therefore cannot modify the other app's accounts. An account tied to an app id that is not configured is ignored on both routes.
- **No credential fallbacks.** Code exchange uses only the signup app's id and secret; template-header uploads use the account's own app (`appId`, or the primary app for legacy accounts) and refuse an unrecognised app. Config validation requires the whole signup trio plus the configuration id when the flag is on, and rejects a copied secret (same app id needs the same secret, different ids need different ones) without printing values.
- **A live Embedded Signup account cannot be replaced by pasting a token.** `POST /agency/whatsapp/connect` answers 409 `embedded_account_active` (before any Meta call, re-checked inside the saving transaction) unless the account is `disconnected`; nothing is changed and the Settings page shows an explanation instead of the manual form. There is no "replace" shortcut: disconnect first. A disconnected row has no credential and may be reused; the manual connect then records no app (`metaAppId` NULL) and clears the embedded markers.
- **A manual token must belong to the original (primary) Meta app.** Connecting subscribes the *token's* app to the WABA, so its webhooks arrive on that app's callback. A token from the signup app would deliver to `/webhooks/whatsapp/signup` while the account is recorded as primary (NULL `metaAppId`), and those events would be acknowledged and ignored. The Settings page says this next to the manual form. TripOS cannot check which app a pasted token belongs to without calling Meta.
- **Unrecognised app identity is never dropped silently.** If an account's `metaAppId` matches neither configured app (for example `WHATSAPP_SIGNUP_APP_ID` was changed after accounts were connected), the webhook route answers **503** for that request so Meta retries it, the account is marked `degraded` (`APP_UNRECOGNISED`, once: at most one write attempt per account per 10 minutes, and the UPDATE matches nothing once flagged) and an error is logged. The health check keeps such an account degraded until the configuration is fixed, and a startup audit flags them too.
  - *Why 503 and not 200:* Meta treats any non-200 as a failed delivery and retries with decreasing frequency for up to 7 days (documented), so fixing the configuration within that window recovers the events. A 200 would lose them for good.
  - *Trade-off:* the whole batch is re-delivered (safe: every event type is de-duplicated, and the healthy accounts' events in the batch were already applied), and the route keeps answering 503 for batches containing such events until the configuration is fixed. An event for a *known* app on the *other* route is not an error: it is answered 200 and left to the other app's route (Meta also retries to every subscribed app).
- **The signup webhook route does not depend on the onboarding flag**, so already-connected signup accounts keep receiving events if the flag is turned off.
- **Validation when any `WHATSAPP_SIGNUP_*` value is set:** all three are required together; `WHATSAPP_APP_ID` (the original app) is required too, so account classification is explicit; placeholder (`<...>`) or whitespace-padded values are rejected; different app ids must have different secrets and the same app id the same secret.
- **Single-app setup is explicitly supported:** set the signup app id/secret equal to the original app's. Every account then resolves to the *primary* route, so the original callback `/webhooks/whatsapp` receives everything. **In this mode `/webhooks/whatsapp/signup` answers 404**, so a callback pointed there by mistake fails visibly instead of acknowledging and silently ignoring events.

## Webhook delivery: payload size, rate limits and retries
- **Body size.** Meta documents webhook payloads of **up to 3 MB**. The API previously parsed every JSON body with a 1 MB limit, which would have refused large `history` chunks with 413 (and Meta would retry them for up to 7 days without success). `/webhooks/*` now has its own limit, `WHATSAPP_WEBHOOK_MAX_BODY_BYTES` (default 4 MiB, allowed 1 MiB to 25 MiB); every other route keeps 1 MB. The raw body is still captured byte-for-byte for signature verification (tested with a 2.5 MB signed payload). An oversize body is reported as `413 payload_too_large` and logged at error level instead of a generic 500.
- **Rate limiting.** The global limit (600 requests/minute/IP) is **unchanged and not exempted for webhooks**: Meta does not document a delivery rate in the pages I checked, and an unauthenticated flood of oversize requests to a rate-limit-exempt route would be cheap to abuse. A throttled delivery is a 429, which Meta retries like any non-200, so it delays rather than loses events. Revisit only with evidence of throttling in logs.
- **Duplicates and retries.** Meta retries any non-200 for up to 7 days and retries can duplicate notifications (both documented). Per event kind:
  - inbound messages, delivery statuses, message echoes, each history message, each contact change, template-status events and account events are de-duplicated by an event key that is **recorded in the same database transaction as the effect**. If applying the effect fails, the key is rolled back with it, so Meta's retry applies the event instead of being suppressed as a duplicate; two simultaneous deliveries of the same event wait on the unique key and apply it once. (Before this hardening, template events, account events including `PARTNER_REMOVED`, and contact syncs recorded the key first and could be lost if the effect then failed.)
  - the health re-read triggered by a quality/limit change runs only after that transaction commits.
  - a batch is processed event by event; an unexpected error (HTTP 500) stops the batch, the events already applied are keyed, and the retry resumes without repeating them. A 429 from the rate limiter happens before any event is processed.
  - an event for an unrecognised app answers 503 only after every other event in the batch was applied.

## Checking legacy rows (read-only)
`metaAppId` NULL means the primary app, which is correct for every account created before the column existed and for manual connections. The only rows that could be misclassified are Embedded Signup accounts created by an earlier build of this branch (NULL `metaAppId` but `onboardingMethod = 'embedded'`). Check, without changing anything:

```sql
-- before the migration (column does not exist yet):
SELECT count(*) FROM "WhatsappAccount" WHERE "onboardingMethod" = 'embedded';
-- after the migration:
SELECT count(*) FROM "WhatsappAccount" WHERE "onboardingMethod" = 'embedded' AND "metaAppId" IS NULL;
```
Both should return 0 before enabling the feature. The API also audits `metaAppId` values at startup (flags, never disconnects) and reports a missing migration clearly instead of failing silently.

## Configuration (names only)
`WHATSAPP_EMBEDDED_SIGNUP_ENABLED` (default `false`), `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`, `WHATSAPP_SIGNUP_APP_ID`, `WHATSAPP_SIGNUP_APP_SECRET`, `WHATSAPP_SIGNUP_VERIFY_TOKEN`, `WHATSAPP_WEBHOOK_MAX_BODY_BYTES` (optional), plus the existing `WHATSAPP_APP_ID` (now required whenever any signup value is set), `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_API_BASE_URL`, `APP_ENCRYPTION_KEY`.
With the cloud provider and the flag on, the signup trio and the configuration id are required at startup. With the simulator provider the flow runs against simulated codes for development.

## Meta prerequisites (manual, outside this repo)
- Tech Provider (or Solution Partner) status; App Review for advanced access to `whatsapp_business_management` and `whatsapp_business_messaging` (until then: at most 10 new customers per rolling 7 days and only people with a role on the app can complete the popup).
- A Facebook Login for Business **configuration for Embedded Signup v4** (this is what selects v4 and the products); its id goes in `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`. Embedded Signup v2 is deprecated on 2026-10-15 and v3 sunsets in October 2026.
- The site's HTTPS domain in the app's *Allowed domains* and *Valid OAuth redirect URIs*.
- On the **signup app** (not the original one): callback `https://<api-host>/webhooks/whatsapp/signup`, its own verify token (`WHATSAPP_SIGNUP_VERIFY_TOKEN`), fields `account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes`, `messages` and the template/quality fields. **Do not change the original app's callback or fields.**
- Business Verification, Tech Provider status and App Review apply to the signup app separately.
- Customer side: WhatsApp Business app 2.24.17 or later; payment method on the WhatsApp Business account; app opened at least every 14 days (primary phone ~14 days / companion ~30 days of inactivity disconnects).

## Verified against Meta's documentation (Oct 2026)
Code exchange endpoint and parameters; 30-second one-time code; `FB.login` and `FB.init` options; `WA_EMBEDDED_SIGNUP` event names (`FINISH`, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, `CANCEL`, `ERROR`) and fields; coexistence skips number registration; `is_on_biz_app`/`platform_type` check; `smb_app_data` request and `sync_type` values; payload shapes for `smb_message_echoes`, `history`, `smb_app_state_sync`, `account_update` (`PARTNER_REMOVED` with `disconnection_info`); India is a supported coexistence country (changelog, 2025-05-05).

## NOT verified (treat as assumptions until the first supervised real run)
- **The configuration's token expires after 60 days** (Meta template `WhatsApp embedded sign-up configuration with 60-day expiry token`, system-user token). TripOS does not track or renew it: see `WHATSAPP_EMBEDDED_SIGNUP_PILOT.md` section 7 for how to know the date and the manual recovery. Whether the code exchange returns `expires_in` is unverified.
- **Two-app webhooks:** that the signup app has its own callback URL, verify token and signing secret in the dashboard, that Meta signs deliveries with *that app's* secret (the docs say "your app secret"), and that a WABA subscribed with the signup app's token delivers to the signup callback only. Verify with the dashboard's test delivery before any real signup.
- That the signup app's token works with `/{app-id}/uploads` of the signup app for template-header examples.
- That Meta does not deliver the same WABA's events to both apps (the design ignores a mismatch rather than depending on it).
- Which setting in the v4 configuration enables coexistence (not stated in the pages read).
- Whether `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` carries `phone_number_id` (the docs show only `waba_id`; the server therefore discovers the number from the WABA when it is missing and refuses if there is not exactly one).
- That `GET /{waba-id}/phone_numbers` works with the exchanged token the way the docs imply, and that the exchange works on the Graph version in `WHATSAPP_API_BASE_URL` (Meta's examples use v25.0).
- The location of the `errors` array in a declined `history` webhook, and the exact `edit`/`revoke` echo shape.
- Order/timing of the contacts and history sync requests; the 24-hour window to request them.
- That `account_update` events are delivered for the app once subscribed, and the exact Meta error codes returned for an expired code.
- `Referrer-Policy: same-origin` (set in `next.config.mjs`) has not been checked against the Meta popup.

## Operational notes
- Migration `20261015100000_whatsapp_signup_attempt_app_id` adds the nullable `WhatsappSignupAttempt.signupAppId` (existing attempts keep NULL; a resumed attempt that holds a token but no recorded app is refused rather than guessed). Apply it together with the next one.
- Migration `20261015090000_whatsapp_account_meta_app_id` adds the nullable `WhatsappAccount.metaAppId` (no backfill; `NULL` = primary app). It is additive and **not yet applied anywhere**. After the Prisma client is regenerated, an API restarted against a database without this column will fail on `WhatsappAccount` queries, so apply it (after a backup) before restarting. Rollback: the old build ignores the column; to remove it use a forward migration.
- Applying the migration `20261014090000_whatsapp_embedded_signup` is additive (new columns with defaults and one new tenant table with RLS). **Regenerate the Prisma client and apply the migration before restarting an API that was built from this branch.**
- The exchanged token is held encrypted on the attempt only between exchange and commit, **never beyond the attempt's original deadline (30 minutes from start)**: re-starting an attempt that already holds a token does not extend it. A sweeper (the existing in-process timer pattern, every 5 minutes and once at startup, only when the job worker runs) closes every unfinished attempt past its deadline and nulls its token, and clears any leftover token on finished or closed attempts. It runs in system context across agencies but only ever nulls the token and closes the attempt. It is idempotent and safe on several instances.
