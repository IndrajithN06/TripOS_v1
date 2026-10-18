# WhatsApp Go-Live Guide (Meta Cloud API)

Status: the Cloud API adapter (`CloudWhatsApp`) is written but has **never been run against Meta**. Use this guide for the first real test; expect to fix small differences.

## 1. What you need
| Item | Where it goes |
|---|---|
| Meta app (type Business) with the WhatsApp product | `WHATSAPP_APP_ID` |
| **App secret** | `WHATSAPP_APP_SECRET` (signs webhooks) |
| A **verify token** you invent | `WHATSAPP_VERIFY_TOKEN` |
| WhatsApp Business Account ID (**WABA ID**) | entered in Settings → WhatsApp |
| **Phone number ID** of the agency's number | entered in Settings → WhatsApp |
| Permanent **system-user access token** (scopes `whatsapp_business_messaging`, `whatsapp_business_management`) | entered in Settings → WhatsApp (stored encrypted, shown once) |
| A **payment method** on the WhatsApp Business Account | Meta charges per message (see §7) |
| A public HTTPS URL to the API | webhook callback |
| Approved message templates | needed for business-initiated messages |

Meta business verification, display-name approval and template approval are Meta's processes and have their own lead times. A Meta **test number** can only message numbers you add to its allowed recipient list.

## 2. Configure the API
In `apps/api/.env` (never commit it):
```
WHATSAPP_PROVIDER=cloud
WHATSAPP_API_BASE_URL=https://graph.facebook.com/v21.0   # confirm the current Graph API version
WHATSAPP_APP_ID=...
WHATSAPP_APP_SECRET=...
WHATSAPP_VERIFY_TOKEN=...
```
Restart the API. With `cloud` selected the simulator and `/dev/*` routes disappear (404) and the UI drops the SIMULATED labels.

## 3. Expose the webhook
Locally, run a tunnel (Cloudflare Tunnel or ngrok) pointing at port 4100. In the Meta app → WhatsApp → Configuration:
- Callback URL: `https://<public-host>/webhooks/whatsapp`
- Verify token: the value of `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the **messages** field.

The GET handshake must return the challenge; the POST handler rejects any request whose `X-Hub-Signature-256` does not match the app secret.

## 4. Connect an agency
Settings → WhatsApp → enter display name, WABA ID, phone number ID, access token → Connect. The `phoneNumberId` links incoming webhooks to the right agency; it must be unique across the platform.

## 5. First real test sequence
1. From your personal phone, message the business number. Expect: conversation appears (no SIMULATED tag), unread badge.
2. Reply in the chat (inside 24 h): message arrives; status moves submitted → sent → delivered → read via webhooks.
3. Create and send a quote: text, PDF, photos arrive. Check the PDF opens and photos are in order.
4. Retry behaviour: temporarily revoke the token or send to an invalid number and confirm failures show as retryable, then retry.
5. Wait out (or fake) the 24 h window and confirm free-form is blocked and only an approved template is accepted.
6. Send the same webhook twice (Meta retries) and confirm no duplicate message.

## 6. Templates
Two ways, both supported:
- **Create in TripOS and submit:** Settings → Templates → write the draft → **Submit for approval**. TripOS sends it to Meta and stores Meta's own status (normally `pending`). It is never treated as approved until Meta says so.
- **Create in Meta Business Manager:** then press **Sync from Meta** (also done automatically when you connect). Templates found in Meta are added locally with their provider status and rejection reason.
Status changes also arrive by webhook (`message_template_status_update`). Only `approved` templates can be sent. Rejected templates can be edited in Meta or resubmitted.

## 7. What is built and what to expect on first contact
Built (phase A, tested against a mocked Meta, **not yet against the real service**): credential check on connect (bad token is rejected with Meta's message); automatic webhook subscription for the agency's WABA; connection health (quality rating, messaging limit, display-name status, last webhook, last check) with states `connected / degraded / disconnected`; periodic health check every 15 minutes; template submit, sync and status webhooks; Meta error classification with plain-language hints; sends blocked while disconnected; a banner for all users when the connection is degraded.
Still expected to need adjustment when first run live: field names and codes in real Meta responses; the Graph API version in `WHATSAPP_API_BASE_URL` (check it is currently supported); permissions on the token.
- Embedded Signup v4 for WhatsApp Business app numbers (coexistence) is built behind `WHATSAPP_EMBEDDED_SIGNUP_ENABLED` (default off) and tested only against a fake Meta; see `WHATSAPP_EMBEDDED_SIGNUP.md`. Manual connection (paste IDs and token) remains the fallback.
- Media: outbound uploads send bytes to Meta then reference the media ID; inbound media is downloaded with the token. Not yet exercised live.
- Error-code mapping is generic (Meta error code and message are stored on the failed message).
- Token expiry/revocation is detected only when a send fails.
- **Meta now bills per message.** Per Meta's developer documentation, service messages (free-form replies inside the 24 h window) and utility messages inside the window became chargeable on 1 October 2026, with 1,000 free service messages per business phone number per month. Marketing, utility and authentication templates are charged by category. A **payment method must be on file** for the WhatsApp Business Account or Meta stops delivering chargeable messages. India is billed in INR plus 18% GST. Check the current INR rate card (Meta publishes it as CSV/PDF) before quoting prices. See `COSTS_AND_PRICING.md`.
- Monitor the quality rating before scaling.

## 8. Before using real customers' numbers
Get explicit approval (see `PRODUCTION_DEPLOYMENT.md`), use a staging number first, and confirm consent and privacy notices.
