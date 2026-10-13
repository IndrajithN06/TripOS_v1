# WhatsApp rich templates, quotation messages and the public quote link

Status: implemented on branch `feature/whatsapp-rich-templates`. Verified with unit tests, e2e tests against a fake Meta, and a browser pass on the local simulator. **Not yet verified against live Meta** (see "Live verification checklist").

## What agencies get

* **Settings → WhatsApp Templates** (Agency Admin manages; Sales can only use approved templates): create, edit, duplicate, delete drafts, preview with sample data and the agency's real details, submit to Meta, sync statuses.
* Purposes: Quotation, Revised quotation, Follow-up, Enquiry acknowledgement, Custom. Category (Utility / Marketing) and language per template.
* Header: none, text, image (agency logo / vehicle photo chosen when sending / uploaded image) or document (the quotation PDF). Body with variables such as `{{customer_name}}`, footer, up to 10 buttons (quick reply, link, call; max 2 link, 1 call).
* **Local draft vs Meta-registered is always shown**: `Local draft` (Meta has never seen it), `Registered with Meta` (submitted from TripOS), `Imported from Meta`. Status is Draft / Submitted / Pending / Approved / Rejected / Paused as reported by Meta. A template is never shown as approved until the provider confirms it (webhook or sync).
* **Quote screen / quote builder: "Send Quotation on WhatsApp"** → pick an approved template (best match for the purpose first), see the exact message, confirm the price for a revised version, send. The template message goes first; the PDF and the selected vehicle photos follow **only if the 24-hour window is open** (otherwise they are reported as deferred, not failed).
* **Inbox → Templates** (beside the composer): approved templates, values pre-filled from the customer and an optional quotation (editable), WhatsApp-style preview, vehicle photo selection, send. Missing values block the send. The result shows the provider message ID and status.
* **Public quotation page** `/q/<token>`: mobile-first, no login, agency branding, photos, PDF download. The customer's phone number is never shown; expired quotes show no prices.
* **Premium minimal PDF and preview**: white page, logo and name on top, one brand colour, large total, aligned price table, photo grid, inclusions / exclusions / terms, contact footer on every page. A5 portrait so it reads on a phone.

## How templates become Meta messages

Authoring uses readable names (`{{customer_name}}`). On save they are compiled to Meta positional form (`{{1}}`) with a stored mapping, so they work with every Meta API version. On submit TripOS sends header/body/footer/button components with example values. Image/document headers need an example file: TripOS uploads it through Meta's Resumable Upload API, which **requires `WHATSAPP_APP_ID`** in `apps/api/.env`.

Limits enforced before anything reaches Meta: header text ≤ 60 chars (one variable), body ≤ 1024, footer ≤ 60 with no variables, button text ≤ 25, ≤ 10 buttons, ≤ 2 link buttons, ≤ 1 call button, link buttons `https` only with at most one variable at the end (`{{quote_token}}`), lowercase-underscore template names.

Variables TripOS fills automatically: `customer_name agency_name agency_phone agency_email agency_website destination pickup_location travel_dates passenger_count vehicle_type quote_total quote_number quote_version valid_until quote_link quote_token`. Any other name is allowed in a template but needs a value at send time.

## Sending rules (Meta compliance)

* Credentials never leave the backend; the browser never talks to Meta.
* Free-form messages (PDF, photos, text) only inside the 24-hour customer service window. A template can be sent any time.
* Only `approved` templates can be sent; the server re-checks, not just the UI.
* Strict variables: the server refuses (400 `template_variables_missing` / `template_media_required`) rather than send blanks or a message without its header media.
* Per-item delivery records (`QuoteSendAttempt`, kind `template` / `pdf` / `image`) with idempotency keys; bounded automatic retry only for transient failures; staff can always retry manually. A failed template message is never shown as sent. Duplicate webhooks are ignored.
* Template send status (accepted by WhatsApp, delivered, read) is tracked on the message; the quote's own status (sent / negotiating / accepted) is separate. Nothing is simulated in production: with `WHATSAPP_PROVIDER=cloud` all sends go to Meta and failures surface as failures.

## Revised quotes (negotiation)

A revised quote is a new immutable version. Sending version 2 or later requires the staff member to confirm the exact new price (`approvedTotal` must equal the version total, otherwise 400 `approval_required`); the UI shows previous → new total with an explicit checkbox. Revised-quotation templates rank first for v2+.

## API (agency-scoped, role-checked on the server)

| Method | Path | Notes |
|---|---|---|
| GET | `/agency/whatsapp/templates` | list (`?status=approved`, `?purpose=`); Admin + Sales |
| GET | `/agency/whatsapp/templates/variables` | automatic variables with samples |
| POST | `/agency/whatsapp/templates/preview` | `{spec}` or `{templateId, conversationId?, quoteId?, versionNumber?, values?}`; strict when real context is given |
| GET/POST/PATCH/DELETE | `/agency/whatsapp/templates[/:id]` | Admin only for writes; only local drafts / rejected are editable (409 `template_locked` otherwise) |
| POST | `/agency/whatsapp/templates/:id/duplicate` · `/submit` · `media/upload` | Admin only |
| POST | `/agency/whatsapp/templates/sync` | pull templates and statuses from Meta |
| GET | `/quotes/:id/versions/:n/templates` | approved templates, window state, price-approval info |
| POST | `/quotes/:id/versions/:n/send-template` | `{templateId, includePdf?, followUpAt?, approvedTotal?}` |
| POST | `/inbox/conversations/:id/messages` | `type:'template'` plus `values`, `quoteId`, `versionNumber`, `headerAssetId`, `photoAssetIds` (the older `variables` array still works) |
| GET | `/public/quotes/:token` · `/public/quotes/:token/pdf` | no auth, rate-limited, token = unguessable per-version link |

## Configuration

| Variable | Purpose |
|---|---|
| `WHATSAPP_APP_ID` | required to submit templates with image/document headers |
| `PUBLIC_QUOTE_BASE_URL` | public address used for `{{quote_link}}` and link buttons (defaults to `APP_URL`; must be https in production) |

Link buttons should point at `<PUBLIC_QUOTE_BASE_URL>/q/{{quote_token}}`. When Meta reviews a template it sees an example link; the real link is built per message.

## Known limitations

* Imported (Meta-created) templates with media headers or buttons are sent with body variables only; they are not modelled for editing.
* "Sales may manage templates when granted" is not implemented: only Agency Admin manages templates.
* The PDF prints amounts as `INR 1,234.00` (the built-in PDF font has no ₹ glyph).
* Marketing-category templates are billed per message by Meta; TripOS does not meter this.

## Live verification checklist (needs a real token)

1. Reconnect WhatsApp in Settings with a fresh token and set `WHATSAPP_APP_ID`.
2. Create the premium quotation template, submit, and confirm `pending` then `approved` after Meta's review (Business Manager → Message templates).
3. Send a quotation to a number inside the window (template + PDF + photos) and outside it (template only).
4. Confirm the link button opens `/q/<token>` from a phone through your public tunnel/host.
5. Revise the price, approve, send v2 with a revised-quotation template.
