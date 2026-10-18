# Embedded Signup pilot runbook (Golden Travels)

Status: the code, migrations and tests are ready; **no real Embedded Signup or coexistence call has been made yet.** Anything marked *unverified* below has only been exercised against a fake Meta. Keep `WHATSAPP_EMBEDDED_SIGNUP_ENABLED=false` until step 5 passes. Placeholders in `<angle brackets>` are filled from your Meta dashboard and tunnel; no secret belongs in this file.

## 1. Origins and exact values
| Setting | Value | Where |
|---|---|---|
| API HTTPS origin | `<API_ORIGIN>` (the existing tunnel to `localhost:4100`) | unchanged; keep serving the original app's callback |
| Original callback | `<API_ORIGIN>/webhooks/whatsapp` | original Meta app: **do not change** |
| Embedded Signup configuration | the one created from Meta's **"WhatsApp embedded sign-up configuration with 60-day expiry token"** template: login variation *WhatsApp Embedded Signup*, **system-user** access token, assets WhatsApp accounts, permissions `whatsapp_business_management` + `whatsapp_business_messaging` (see section 7 for the 60-day limit) | signup app → Facebook Login for Business → Configurations; its id is `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`. The earlier General-login / user-token configuration is kept only as a fallback and should not be used (a user token is short-lived and tied to one person) |
| **Signup callback** | `<API_ORIGIN>/webhooks/whatsapp/signup` | signup Meta app → WhatsApp → Configuration |
| **Web HTTPS origin** | `<WEB_ORIGIN>` (a second tunnel or host to `localhost:3100`) | see section 2 |
| `APP_URL` | exactly `<WEB_ORIGIN>`: scheme + host (+ port), **no path, no trailing slash** | `apps/api/.env` |
| Signup app → Allowed domains / App domains | the host of `<WEB_ORIGIN>` | Facebook Login for Business → Settings, App settings |
| Signup app → Valid OAuth redirect URIs | `<WEB_ORIGIN>` (add `<WEB_ORIGIN>/` too if Meta rejects the bare origin: *unverified*) | same |

The API accepts exactly one browser origin (`CsrfGuard`: the request's `Origin` must equal `APP_URL`; tested in `csrf-origin.spec.ts`), so during the pilot staff must open TripOS from `<WEB_ORIGIN>`, not `http://localhost:3100`. CORS uses the same value. The web app proxies `/api/*` to the API (`API_INTERNAL_URL`, default `http://localhost:4100`), so browser calls are same-origin and the API itself does not need to be public for the UI, only for webhooks.

`.env` additions (names; values from the dashboard, never committed):
```
WHATSAPP_APP_ID=<original Meta app id>                 # required as soon as any SIGNUP value is set
WHATSAPP_SIGNUP_APP_ID=<signup Meta app id>
WHATSAPP_SIGNUP_APP_SECRET=<signup app secret>         # that app's OWN secret, different from WHATSAPP_APP_SECRET
WHATSAPP_SIGNUP_VERIFY_TOKEN=<new random string>       # also entered in the signup app's webhook settings
WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID=<configuration id>
APP_URL=<WEB_ORIGIN>
WHATSAPP_EMBEDDED_SIGNUP_ENABLED=false                 # flip to true only in step 5
```
Do not change `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` or the original app's dashboard settings.

## 2. HTTPS for the web app
Meta supports only HTTPS domains for the popup (documented). Do **not** stop or replace the existing API tunnel.

**Do not simply run `ngrok http 3100`.** ngrok's free plan has one dev domain, and its documentation says that domain "can point up to 3 online endpoints at it": a second endpoint on the same domain is pooled with the live API tunnel, which would split webhook traffic between port 4100 and the web app (port 3100) and break the original app's callback. A second endpoint is only safe on a *different* domain (needs a paid plan or an additional reserved domain; not verified for this account).

Safe options, in order of preference:
1. **A separate tunnel tool for the web app only**, for example Cloudflare's `cloudflared tunnel --url http://localhost:3100` (a quick tunnel needs no account and gives a random `*.trycloudflare.com` HTTPS URL; it does not touch ngrok or any running service). The hostname changes on every start, so Meta's domain settings and `APP_URL` must be updated each time. Not installed on this machine at the time of writing.
2. An existing staging host with HTTPS.
3. Moving both callbacks and the UI behind one domain by proxying `/webhooks/*` through the web app. This changes the live tunnel's target and needs a web change and rebuild; do not do it without a separate review.

A tunnel makes the staff login page public: use strong passwords/MFA and close it after the pilot. Verify the page loads over HTTPS (login page visible) before using the origin in Meta. ngrok-style interstitial pages (free plan) appear only for the first browser visit and do not affect the popup once dismissed.

## 3. Meta dashboard checklist (signup app; nothing here is done until you confirm it)
- [ ] Developer account confirmation error resolved (status unknown).
- [ ] Webhook: callback `<API_ORIGIN>/webhooks/whatsapp/signup`, the dedicated verify token, "Verify and save" succeeds (needs the new build running with the signup values; see section 4).
- [ ] Webhook fields subscribed: `account_update` (required by Meta), `history`, `smb_app_state_sync`, `smb_message_echoes`, `messages`, `message_template_status_update`, `phone_number_quality_update`.
- [ ] Signup app secret copied into `WHATSAPP_SIGNUP_APP_SECRET` (never reuse the original app's).
- [ ] Facebook Login for Business configuration `<configuration id>`: WhatsApp Embedded Signup variation, v4, WhatsApp Cloud API product, permissions `whatsapp_business_management` and `whatsapp_business_messaging`. Confirm whether it offers the "connect existing WhatsApp Business app number" (coexistence) option: *the docs do not say how it is enabled*.
- [ ] Allowed domains and Valid OAuth redirect URIs set (section 1).
- [ ] App in Development mode: the person running the popup has a role (admin/developer/tester) on the signup app and is admin of the business that owns the WABA.
- [ ] Golden Travels number: on the WhatsApp Business app 2.24.17 or later, payment method on the WhatsApp Business account, app opened regularly (primary phone ~14 days / companion ~30 days of inactivity disconnects).

Pilot vs scale: the pilot needs only the above. Onboarding outside your own app roles needs Business Verification, Tech Provider status, App Review for advanced access to both permissions, and privacy/terms/data-deletion pages (not built). Until verified, Meta limits onboarding to 10 customers per rolling 7 days.

## 4. Deploy the new build with signup still disabled
Prerequisites: backup taken, both migrations applied (`npx prisma migrate status` up to date), `.env` has the section 1 values, unit and e2e tests green.
```
cd apps/api
npm run preflight                      # must end "OK"; warnings about enabling are expected until step 5
```
Preserve the running artifacts, then rebuild (stop the API first: the Prisma engine file is locked while it runs):
```
# PowerShell, from the repo root
$ts = Get-Date -Format yyyyMMdd-HHmmss; $b = "D:\TRIP_OS\backups\artifacts-$ts"; New-Item -ItemType Directory $b | Out-Null
Copy-Item apps\api\dist "$b\api-dist" -Recurse; Copy-Item apps\web\.next "$b\web-next" -Recurse
Stop-Process -Id <API_PID>; npm run build -w @tripos/api
Start-Process node -ArgumentList dist/main.js -WorkingDirectory apps\api        # same start as before; no overrides
Stop-Process -Id <WEB_PID>; npm run build -w @tripos/web; Start-Process cmd -ArgumentList '/c','npm run start -w @tripos/web'
```
Checks (all must pass before continuing): `/health` and `/health/ready` OK; startup log says `whatsapp=cloud`; `GET <API_ORIGIN>/webhooks/whatsapp/signup?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1` returns **403** (route live; 404 means the signup values are missing); the primary route still answers; the existing account stays `connected` after its next 15-minute health check; the web page loads at `<WEB_ORIGIN>`.

**Rollback** (the migrations are additive and the previous build ignores the new columns, so the database normally needs no restore):
```
Stop-Process -Id <NEW_API_PID>; Remove-Item apps\api\dist -Recurse; Copy-Item "$b\api-dist" apps\api\dist -Recurse
Start-Process node -ArgumentList dist/main.js -WorkingDirectory apps\api       # and the same for web\.next
```
Database restore from the dump (`pg_restore --clean`) only for a genuine data problem, after review.

## 5. Enable and run the supervised signup
1. `npm run preflight -- --enable` must end OK (public HTTPS `APP_URL`, whole signup config, nothing unrecognised).
2. Create a **separate** "Golden Travels" agency with no WhatsApp connection (Super Admin console). One agency has one account, signup refuses a live connection, and the working connection (`WA Live Test`) must not be touched.
3. Optional dry run with a Meta sandbox account: it must stop at `not_coexistence` without connecting anything.
4. Set `WHATSAPP_EMBEDDED_SIGNUP_ENABLED=true`, restart the API only, open TripOS at `<WEB_ORIGIN>` as that agency's admin → Settings → WhatsApp → Connect with Facebook. The Golden Travels admin completes the Meta window; accept or decline history sharing there.
5. Limitation: a WABA with more than one phone number is refused (`phone_selection_required`); choosing a number is not built.

## 6. Acceptance
Inbound message appears in the inbox; a template from TripOS reaches the phone (Golden's templates must be submitted and approved on their WABA first); a message typed in the Business app appears as an echo without opening the 24 h window; contacts and history import once; the app keeps working on the phone; disconnecting from the phone marks the account `disconnected` and erases the credential; the original connection is unchanged throughout. Watch the API log for `ALERT app_unrecognised_503` and `payload_too_large`.

## 7. Known limitation: the 60-day system-user token
The configuration issues a system-user token that **expires 60 days after signup** (Meta's template setting; the default for system-user tokens is non-expiring, but this template sets 60 days). TripOS stores whatever token the code exchange returns and does **not** read, track or renew its expiry. Around day 60 Meta rejects the token: the health check marks the account `degraded` with an auth error, and sends fail with "the WhatsApp access token is invalid, expired or lacks permission". Nothing else in TripOS breaks, and the WhatsApp Business app on the phone keeps working.

**Know the date.** `subscribedAt` is set when the account connects (token issued). Read-only check:
```sql
SELECT "displayName", "subscribedAt" + interval '60 days' AS token_expires_about, "connectionStatus", "lastErrorCode"
FROM "WhatsappAccount" WHERE "onboardingMethod" = 'embedded' AND "connectionStatus" <> 'disconnected';
```
Put a reminder at day 50. (Whether the exchange response carries `expires_in` is unverified; TripOS ignores it.)

**Recovery (manual, about 5 minutes; nothing is lost):**
1. Settings → WhatsApp → **Disconnect**. This erases the dead credential only; customers, conversations, messages and templates stay in TripOS, and the row can be reused.
2. The number's owner runs **Connect with Facebook** again (the flag must be on). A fresh token is issued (60 days again). The number is already registered, so no registration or PIN step happens.
3. Request contacts and history again within 24 hours of the new onboarding (the connect screen's import option). Messages already stored are skipped by message id.
4. Check Settings: status `connected`, quality rating present, templates synced.
While disconnected TripOS cannot send, and incoming messages are not recorded in TripOS (they still arrive in the phone app); the history import on reconnect covers the gap as far as Meta shares it.

**Longer term (not built):** record the expiry and warn before it, or use a non-expiring system-user configuration if Meta's configuration screen offers one (unverified).

## 8. Supervised test checklist
Prerequisites: sections 1-6 done; `npm run preflight -w @tripos/api -- --enable` passes; a **temporary test agency** (not `WA Live Test`); the popup user has a role on the signup app. Enabling the feature needs ONE API restart, which also loads the new configuration id; until then the running API still holds the old id.

| Step | What you do | What you should see | Verified by |
|---|---|---|---|
| 1 Popup launch | Open TripOS at `<WEB_ORIGIN>`, log in as the test agency's admin → Settings → WhatsApp → enter a display name → **Connect with Facebook** | the Meta window opens (not an "invalid app/config" error) | browser; a config/app mismatch fails here |
| 2 Authorization | complete Meta's screens (business, WABA, number) | the window closes; TripOS shows "Finishing the connection…" | browser |
| 3 Code exchange | automatic | no "authorization code" error | Settings message; `WhatsappSignupAttempt.step/status` |
| 4 Account selection | automatic: the reported WABA/number are checked against Meta | for a coexistence number: continues; for a test/sandbox number: stops with "not linked to the WhatsApp Business app" | Settings message; attempt `lastErrorCode` |
| 5 Backend validation | automatic | connected account shows `onboardingMethod = embedded`, coexistence, `connected` | Settings; DB |
| 6 Webhook delivery | in the signup app's webhook settings use **Test** for `messages`/`account_update` | HTTP 200 for each in the ngrok inspector (`http://127.0.0.1:4040`), not 401 | ngrok inspector (shows whether Meta signs with the signup app's secret) |
| 7 Inbound | message the number from another phone | message appears in the inbox | inbox |
| 8 Outbound | reply inside 24 h, then send an approved template | delivered/read ticks | inbox; phone |
| 9 Coexistence | type a message in the WhatsApp Business app; check history/contacts import | echo appears in TripOS without opening the 24 h window; the app still works on the phone | inbox; phone |
Read-only state check at any time:
```sql
SELECT status, step, "failedStep", "lastErrorCode", ("tokenRef" IS NOT NULL) AS holds_token, "signupAppId" IS NOT NULL AS app_recorded
FROM "WhatsappSignupAttempt" ORDER BY "createdAt" DESC LIMIT 3;
```

**What each kind of number can prove**
- *Meta test number / sandbox account* (cannot message in the sandbox; not on the WhatsApp Business app): steps 1-4 only, ending at "not linked to the WhatsApp Business app" with nothing connected. This validates the configuration, popup, token exchange and ownership checks. It cannot prove coexistence, history sync, echoes, `PARTNER_REMOVED` or signed-in-app behaviour.
- *An eligible real WhatsApp Business app number* (Golden Travels, or a spare one on version 2.24.17 or later): steps 5-9 and the real coexistence behaviour.
- *Original app's existing manual connection* (`WA Live Test`): unrelated to this flow; leave it alone.
