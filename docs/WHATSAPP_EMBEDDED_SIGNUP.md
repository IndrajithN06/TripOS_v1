# WhatsApp Embedded Signup v4 (coexistence)

Status: **implemented behind a feature flag (default off); tested only against a fake Meta. Not yet verified end to end against the real service.**
Pilot target: an agency whose number is already on the WhatsApp Business app, which keeps working while TripOS also uses it ("coexistence").
Manual connection (paste WABA ID, phone number ID, token) is unchanged and remains the fallback.

## What it does
1. Admin opens Settings → WhatsApp → **Connect with Facebook** (only shown when the flag is on).
2. `POST /agency/whatsapp/embedded/start` creates a resumable attempt and returns a one-time `state` value (stored only as a hash).
3. The browser loads Meta's JS SDK and runs `FB.login` with the configuration id (`response_type: 'code'`, `override_default_response_type: true`, `extras: { setup: {} }`).
4. The popup reports the connected account (`WA_EMBEDDED_SIGNUP` message event: `FINISH` or `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) and, via the `FB.login` callback, a one-time code.
5. `POST /agency/whatsapp/embedded/complete` (server side, agency taken from the session):
   1. checks attempt ownership, the `state` value and expiry; takes an atomic run lock;
   2. records the code's hash, then exchanges it (`GET /oauth/access_token` with the app id and secret) and stores the token encrypted (AES-GCM) on the attempt;
   3. **verifies ownership**: the token must list the reported WABA's phone numbers and include the reported number; neither may belong to another agency; the number must report `is_on_biz_app: true`;
   4. subscribes the app to the WABA's webhooks and reads the number's health;
   5. commits in one transaction, **only if the agency has no live WhatsApp connection**, then erases the token from the attempt;
   6. best effort: requests contacts and history sync (`POST /{phone-number-id}/smb_app_data`) if the admin asked, and syncs templates.
6. Each step is recorded; a failure keeps the (encrypted) token so **Resume** needs no new code, unless the failure is final.

It never registers, migrates or deregisters a number, and never overwrites or disconnects an existing connection.

## Webhooks for coexistence numbers
| Field | Handling |
|---|---|
| `smb_message_echoes` | Message typed in the Business app → stored as an outbound message (`sent`, no TripOS user). Does not open the 24 h window. Edit/revoke echoes are acknowledged, not applied. |
| `history` | Imported once per message id; original timestamps kept; never raises unread or opens the window. A declined share (error `2593109`) is recorded on the account (`lastErrorCode`) without failing anything. |
| `smb_app_state_sync` | Added contacts become customers; existing names are kept; removals never delete data. |
| `account_update` / `PARTNER_REMOVED` | Embedded-Signup account → `disconnected`, credential erased. Manually connected account → `degraded`, credential kept. WABA is read from `waba_info.waba_id` (the entry id can be a partner business id). |
These three data fields are ignored for accounts that were not onboarded as coexistence numbers.

## Configuration (names only)
`WHATSAPP_EMBEDDED_SIGNUP_ENABLED` (default `false`), `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`, plus the existing `WHATSAPP_APP_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_API_BASE_URL`, `APP_ENCRYPTION_KEY`.
With the cloud provider and the flag on, the app id, secret and configuration id are required at startup. With the simulator provider the flow runs against simulated codes for development.

## Meta prerequisites (manual, outside this repo)
- Tech Provider (or Solution Partner) status; App Review for advanced access to `whatsapp_business_management` and `whatsapp_business_messaging` (until then: at most 10 new customers per rolling 7 days and only people with a role on the app can complete the popup).
- A Facebook Login for Business **configuration for Embedded Signup v4** (this is what selects v4 and the products); its id goes in `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`. Embedded Signup v2 is deprecated on 2026-10-15 and v3 sunsets in October 2026.
- The site's HTTPS domain in the app's *Allowed domains* and *Valid OAuth redirect URIs*.
- Webhook subscriptions on the app: `account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes` (plus the existing `messages` etc.). Do not change the callback URL.
- Customer side: WhatsApp Business app 2.24.17 or later; payment method on the WhatsApp Business account; app opened at least every 14 days (primary phone ~14 days / companion ~30 days of inactivity disconnects).

## Verified against Meta's documentation (Oct 2026)
Code exchange endpoint and parameters; 30-second one-time code; `FB.login` and `FB.init` options; `WA_EMBEDDED_SIGNUP` event names (`FINISH`, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, `CANCEL`, `ERROR`) and fields; coexistence skips number registration; `is_on_biz_app`/`platform_type` check; `smb_app_data` request and `sync_type` values; payload shapes for `smb_message_echoes`, `history`, `smb_app_state_sync`, `account_update` (`PARTNER_REMOVED` with `disconnection_info`); India is a supported coexistence country (changelog, 2025-05-05).

## NOT verified (treat as assumptions until the first supervised real run)
- Which setting in the v4 configuration enables coexistence (not stated in the pages read).
- Whether `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` carries `phone_number_id` (the docs show only `waba_id`; the server therefore discovers the number from the WABA when it is missing and refuses if there is not exactly one).
- That `GET /{waba-id}/phone_numbers` works with the exchanged token the way the docs imply, and that the exchange works on the Graph version in `WHATSAPP_API_BASE_URL` (Meta's examples use v25.0).
- The location of the `errors` array in a declined `history` webhook, and the exact `edit`/`revoke` echo shape.
- Order/timing of the contacts and history sync requests; the 24-hour window to request them.
- That `account_update` events are delivered for the app once subscribed, and the exact Meta error codes returned for an expired code.
- `Referrer-Policy: same-origin` (set in `next.config.mjs`) has not been checked against the Meta popup.

## Operational notes
- Applying the migration `20261014090000_whatsapp_embedded_signup` is additive (new columns with defaults and one new tenant table with RLS). **Regenerate the Prisma client and apply the migration before restarting an API that was built from this branch.**
- The exchanged token is held encrypted on the attempt only between exchange and commit (max 30 minutes), then removed.
