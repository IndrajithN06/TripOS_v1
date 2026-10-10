# TripOS Business Guide

For agency owners, sales staff and the TripOS platform owner. It explains what the product does, the rules it follows, and how a day-to-day workflow runs. Technical detail is in the other documents.

## 1. What TripOS is
A multi-tenant SaaS for travel agencies and cab operators. Its V1 job is narrow and deliberate:

> **Enquiry arrives on WhatsApp → understand it → quote from your own rates → send a branded quote with vehicle photos → negotiate in the same chat → track the pipeline.**

Each agency is an independent tenant with its own users, branding, vehicles, rates, customers, chats and quotes. One agency can never see another's data.

**Not in V1:** dispatch, driver or vehicle registration, trip execution, bookings, invoicing, payments, accounting, Google Ads, a general-purpose CRM. See `ROADMAP.md`.

## 2. Who does what
| Role | Who | Can do |
|---|---|---|
| **Super Admin** | TripOS platform owner | Create, suspend and reactivate agencies; invite an agency's first admin; see per-agency usage and failed jobs; switch AI off platform-wide. **Cannot** read agency chats or quotes by default. Cross-agency support access needs a written reason, expires within 5-60 minutes, and is audited. |
| **Agency Admin** | Agency owner or manager | Everything inside their agency: team, branding, vehicles and rates, WhatsApp connection, templates, tax and quote settings, all chats and quotes, full dashboard. |
| **Sales** | Agency staff | Handle chats, create/edit/send quotes, add notes, follow up. Can view vehicles but not change them. Cannot see settings, other agencies or integration secrets. Changing rates or applying discounts is allowed only if the admin has enabled "can change rates" for that person. |

Agency admins can choose whether Sales see **all** agency chats and quotes or **only their own / assigned** ones (Settings → Quotes, tax & AI).

## 3. Setting up an agency (first day)
1. **Super Admin** creates the agency (name, slug, first admin's name and email). The admin receives an invitation link to set a password (valid 72 hours, single use).
2. **Agency Admin** then:
   - uploads the logo and picks the brand colour, tagline, contact details, default inclusions/exclusions and terms (Settings → Profile & branding). Changes appear immediately across the app;
   - adds **vehicle types** with the full rate card and photos (see §4);
   - invites sales team members (Settings → Team). A lost or expired link can be re-issued with **Resend invite**; **Reset password** issues a fresh link to someone already active;
   - connects the agency's WhatsApp Business number (Settings → WhatsApp);
   - sets tax (rate, on/off, inclusive or exclusive) and quote validity (Settings → Quotes, tax & AI);
   - optionally drafts WhatsApp message templates.

## 4. Vehicle types and rate cards
A vehicle **type** (for example "Innova Crysta") is what customers are quoted. TripOS does **not** track individual registrations or drivers in V1.

Per type the admin sets: name, category, seats, description, amenities, and the rate card:
| Field | Meaning |
|---|---|
| Local slab A (default 8 hr / 80 km) | Fixed package price. Hours and km are configurable. |
| Local slab B (default 4 hr / 40 km) | Second fixed package. |
| Extra hour, extra km | Charged beyond the package. |
| Outstation rate per km | Charged per billable km. |
| Minimum km per day | Billable km can never fall below days x this value. |
| Driver batta per day | Charged per day on outstation trips. |
| Optional defaults | Toll, parking, permit, interstate tax. |

Nothing is hard-coded: every number is the agency's own. Changing a rate affects **new** quotes only. Each quote version stores a snapshot of the rate card it was built from, so old quotes never silently change.

**Photos:** upload several JPEG/PNG images (5 MB each, up to 12), reorder them, choose a primary, add captions and alt text. Sales choose which photos suit each customer.

**Archive, don't delete:** archived types disappear from quote creation but remain in historical quotes.

## 5. Daily workflow
### 5.1 A new enquiry
A customer messages the agency's WhatsApp number. TripOS finds or creates the customer and conversation (by phone number), stores the message, shows an unread badge, and optionally lets AI summarise or extract trip details.

### 5.2 Building a quote (in the chat)
1. Open the conversation, click **New quote**.
2. Fill trip details: type (outstation / local), pickup and return date-time (shown in agency time, IST by default), locations, passengers, days, estimated km, itinerary.
3. Choose the vehicle; the rate card loads. Optionally override rates, add named extra charges (toll, parking, permit...) and a discount (amount or %), subject to your permission.
4. Tick the vehicle photos relevant to this customer.
5. Watch the **price summary** update. It is always calculated by the server; the page only displays it.
6. **Save & preview** shows the branded customer view and a PDF. **Send via WhatsApp** delivers it.

### 5.3 What the customer receives
A text summary, the branded **PDF** quotation, then each selected photo as a separate image. All use the **agency's** name and branding, never TripOS's.

### 5.4 If something fails
Delivery is tracked per item. If the PDF arrives but one photo fails, the quote shows **partially sent**; **Retry failed items only** resends just that photo. Nothing already delivered is sent twice.

### 5.5 Negotiating
A sent version is **locked**. To change price, vehicle, charges or photos choose **Edit / Requote**: TripOS creates **version 2** (version 1 and its PDF remain exactly as the customer received them) and the **Compare** view shows the difference. Send version 2 the same way.

### 5.6 Closing
Mark the quote **accepted** or **declined** manually. A WhatsApp "read" receipt never counts as acceptance. Set a **follow-up date** on quotes awaiting a reply; overdue ones appear in the dashboard and quote list.

### 5.7 Quote statuses
`draft → ready_to_send → sent → negotiating → accepted | declined | expired`, plus `send_failed`. Sent quotes become **expired** automatically after the validity period (default 7 days).

## 6. Pricing rules (worked examples)
Order of calculation: lines → subtotal → discount → tax on (taxable lines minus discount) → total. Amounts are rounded half-up to 2 decimals.

**Local package** (8 hr / 80 km = ₹3,500, extra km ₹23, extra hour ₹300), actual 10 hr / 105 km:
3,500 + 25 km x 23 (575) + 2 hr x 300 (600) = **₹4,675**.

**Outstation** (₹20/km, min 300 km/day, batta ₹800/day), 3 days, estimated 750 km:
billable km = max(750, 3 x 300) = 900 → 900 x 20 = 18,000 + batta 3 x 800 = 2,400 = **₹20,400**.

**Discount and tax:** a ₹500 discount on ₹3,500 with 5% exclusive tax: taxable base 3,000, tax 150, total **₹3,150**. Lines marked "not taxable" (for example toll) stay out of the tax base. In *inclusive* mode the tax is contained in the price and the total does not change.

## 7. WhatsApp rules (set by Meta, enforced by TripOS)
- **24-hour window:** free-form messages are allowed only within 24 hours of the customer's last message. Outside it, only an **approved template** can be sent. The chat shows whether the window is open.
- **Templates** have a status reported by the provider: local draft → submitted → pending → approved / rejected / paused. TripOS never treats a template as approved until the provider says so, and checks variables before sending.
- Each agency uses its **own** WhatsApp Business number.
- In the current local environment every message is labelled **SIMULATED**; nothing reaches real WhatsApp.

## 8. AI assistance (optional)
Summaries, trip-detail extraction, reply suggestions, quote drafting and negotiation suggestions. **Rules:** AI only proposes drafts; staff review everything; AI never sets prices, applies discounts or sends anything. Customer messages are treated as untrusted text. If AI is off or unavailable, everything else keeps working. Agencies have a monthly call limit and can switch AI off; the platform owner has a kill switch.

## 9. The dashboard
Choose 7, 30 or 90 days. Figures are consistent with the underlying records.
| Measure | Definition |
|---|---|
| Open pipeline | Sum of the **current version** total of sent/negotiating, unexpired quotes (never historical versions). Admin only. |
| Enquiries | New conversations in the period. |
| Quotes created | **Parent** quotes created (versions counted separately). |
| Accepted | Quotes manually marked accepted in the period, with their value. |
| Conversion | Accepted ÷ sent quotes created in the period. |
| Average quote value | Mean current-version total. |
| First response | Median time from a customer's first message to the first reply. |
| Delivery success | Share of quote items (text, PDF, photos) delivered. |
| Follow-ups due | Sent quotes whose follow-up date has passed. |
| Funnel | Enquiries → quotes created → quotes sent → accepted. |
| Heatmap | Inbound messages by weekday and hour (agency time). |
Each change is shown against the previous period of equal length. Sales users see only their own quotes. Alerts appear for failed sends and for messages that failed and were not followed up.

## 10. Data, privacy and retention
- Every record carries its agency; isolation is enforced by the application **and** the database.
- Provider credentials are stored encrypted and are never shown again.
- Sensitive actions (rate changes, user changes, discounts, sends, status changes, support access) are written to an audit log.
- Retention and consent policy has **not** been defined; nothing is auto-deleted. Decide before launch (see `DECISIONS_AND_ASSUMPTIONS.md`).

## 11. Glossary
**Tenant/agency:** one customer company of TripOS. **Vehicle type:** a category of vehicle quoted (not a specific car). **Rate card:** an agency's prices for a vehicle type. **Quote version:** an immutable-once-sent snapshot of a quotation. **Batta:** driver daily allowance. **WABA:** WhatsApp Business Account. **Template:** a pre-approved WhatsApp message. **Simulator:** the local stand-in for WhatsApp used before Meta approval.

## 12. FAQ
- *Can a sent quote be edited?* No. Requote to create a new version.
- *Why can't I send a normal message?* The 24-hour window closed; use an approved template.
- *Why can't Sales change the price?* The admin controls that per person (Settings → Team).
- *A teammate's invite link doesn't work.* Use Settings → Team → **Resend invite** or **Reset password**.
- *Does the platform owner read our chats?* Not by default; any exception is time-limited and audited.
