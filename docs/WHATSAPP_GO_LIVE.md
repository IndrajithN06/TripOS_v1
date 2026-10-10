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
Create templates in **Meta Business Manager** (category, language, body with `{{1}}` variables). Mirror the name, language and variable list in Settings → Templates, then set the status. Automatic submission and status sync are **not built** (see `ROADMAP.md` R1). Until synced, mark status by hand in the database or build the sync first; only `approved` templates can be sent.

## 7. Known gaps to expect on first contact
- Embedded Signup (self-service onboarding) is not built; IDs and tokens are pasted in manually.
- Media: outbound uploads send bytes to Meta then reference the media ID; inbound media is downloaded with the token. Not yet exercised live.
- Error-code mapping is generic (Meta error code and message are stored on the failed message).
- Token expiry/revocation is detected only when a send fails.
- Meta's per-conversation pricing and quality rating apply; monitor the quality rating before scaling.

## 8. Before using real customers' numbers
Get explicit approval (see `PRODUCTION_DEPLOYMENT.md`), use a staging number first, and confirm consent and privacy notices.
