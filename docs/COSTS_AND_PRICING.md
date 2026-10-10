# Costs and Pricing (planning estimates)

> **These are planning estimates, not quotes.** Developer-effort and infrastructure figures are the author's assumptions and must be replaced with real quotes. Meta's INR rate card must be checked directly (below). Subscription prices are suggestions to validate with pilot agencies. Currency: INR. GST at 18% applies on top where stated.

## 1. One-time investment to reach "production ready"
Scope = the open items in `ROADMAP.md` section A, plus billing and launch work. The core product (multi-tenant app, quoting, inbox, dashboard) already exists; this is what remains.

| Work item | Effort (person-days) | Notes |
|---|---|---|
| Meta template submission and status sync (R1) | 3-5 | |
| Live verification and fixes of WhatsApp Cloud adapter (R2) | 3-6 | Depends on Meta approval and real traffic |
| Live verification of S3, OpenAI, Resend; optional SMTP adapter (R3) | 2-4 | |
| Embedded Signup (R4) | 5-8 | Plus Meta app review wait; can launch without it by onboarding agencies manually |
| Realtime inbox (R5) | 3-4 | Optional for first pilots |
| Browser E2E tests and accessibility pass (R6) | 5-7 | |
| Self-service password reset, MFA screen (R7) | 3-4 | |
| Production setup: hosting, database, CI/CD, monitoring, backups, restore drill (R8) | 5-8 | |
| Retention/consent/deletion features (R9) | 3-5 | Plus legal review below |
| Follow-up reminders (R10) | 3-5 | Needs the open decision on recipients |
| Polish items (R11) and per-tenant rate limits (R12) | 5-8 | |
| **Subscription billing**: plans, limits enforcement, invoices, payment gateway | 6-10 | **Not built.** The `plan` field exists but nothing charges or enforces it. Manual invoicing is a workable first step. |
| Pilot support and fixes with 2-3 agencies | 8-12 | |
| **Total** | **~55-90** | |

| Cost line | Estimate |
|---|---|
| Development at ₹3,000-8,000 per person-day (freelancer to small agency) | ₹1.7L - ₹7.2L |
| Legal: terms of service, privacy policy, data-processing terms | ₹30,000 - ₹1,00,000 |
| Independent security test (recommended before real customer data) | ₹50,000 - ₹1,50,000 |
| Contingency (15%) | ₹0.5L - ₹1.5L |
| **One-time total** | **≈ ₹3L (lean) to ≈ ₹10L (comfortable)** |

Meta business verification and WhatsApp account setup have no Meta fee, but take calendar time. Domain and branding assets are small additions.

## 2. Monthly running costs (platform, not per customer)
| Item | Estimate / month | Notes |
|---|---|---|
| App hosting (API + web, two small services) | ₹2,500 - 6,000 | scales with traffic |
| Managed PostgreSQL with backups | ₹2,500 - 6,000 | |
| Object storage and transfer (photos, PDFs) | ₹100 - 500 | grows with photos |
| Email (invitations) | ₹0 - 2,000 | check provider limits |
| Error monitoring and uptime | ₹0 - 2,500 | |
| Domain and HTTPS | ~₹100 | |
| **Infrastructure subtotal (first 10-30 agencies)** | **≈ ₹8,000 - 20,000** | |
| Maintenance and support (part-time developer) | ₹40,000 - 80,000 | the largest line; depends on who does it |

## 3. Per-agency variable costs
### WhatsApp (paid to Meta, per message)
Per Meta's developer documentation (verified October 2026): messages are billed **per message** by category; **service messages** (replies in the 24-hour window) and **utility messages in the window became chargeable on 1 October 2026**, with **1,000 free service messages per business phone number per month**; a **payment method must be on file** or chargeable messages stop being delivered; India is billed in INR plus 18% GST.

Third-party summaries of the India rate card disagree slightly; they put utility/authentication/service at about **₹0.115-0.145** and marketing at about **₹0.86-1.09** per message before GST. **Download Meta's INR rate-card CSV and confirm** before setting any price.

Example, using ₹0.145 plus GST: an agency sending 5,000 messages a month pays about (5,000 - 1,000) x 0.145 x 1.18 ≈ **₹680**. A quote delivered as text + PDF + 3 photos is 5 messages. A BSP, if used, adds its own fee. Marketing broadcasts are not a V1 feature.

### Other per-agency costs
| Item | Estimate / month |
|---|---|
| AI (at the default 200 calls; small model) | ₹10 - 300, depending on provider and prompt size (measure with real usage) |
| Storage and database share | ₹100 - 500 |
| Payment gateway fees on subscriptions | ~2% of the subscription |
| Support time | the dominant cost; plan for onboarding calls in month one |

Typical variable cost: **₹300 - 1,500 per agency per month**, mostly WhatsApp.

## 4. Suggested subscription pricing
Principle: price on **value** (faster, consistent, branded quotes; fewer lost enquiries), not on cost. Indian SMB tools in this space commonly sit in the low thousands of rupees per month plus message fees; validate against 3-5 pilot agencies. Limits below use things the product can actually meter today (users, quotes, AI calls); enforcement of plans is part of the billing work in section 1.

| | **Starter** | **Growth** | **Pro** |
|---|---|---|---|
| Price per month (excl. GST) | **₹1,999** | **₹4,999** | **₹9,999** |
| Users | 1 admin + 2 sales | 1 admin + 6 sales | 1 admin + 15 sales |
| WhatsApp number | 1 | 1 | 1 (multiple numbers is a roadmap item) |
| Vehicle types, photos | unlimited | unlimited | unlimited |
| Quotes per month | 300 | 1,500 | 5,000 |
| AI calls per month | 100 | 500 | 2,000 |
| Dashboard | headline KPIs | full analytics | full analytics |
| Support | email | email + chat | priority + onboarding session |

- **WhatsApp fees:** pass through at Meta's rate plus GST (optionally +10-20% handling), billed as usage, or include a small message allowance per tier. Each agency pays Meta directly if you can set it up that way, which avoids you carrying the float.
- **Setup fee (optional):** ₹5,000-15,000 for assisted onboarding (Meta setup, entering rate cards and photos, branding).
- **Annual plan:** 2 months free (about 17% off).
- **Pilot offer:** discounted or free for 2-3 months in exchange for feedback and a testimonial.

## 5. Break-even illustration
Assumptions: average revenue per agency ₹3,500/month (a mix of tiers), variable cost ₹500 per agency, platform costs of about ₹1.0L/month (infrastructure plus part-time maintenance and support), excluding GST and WhatsApp pass-through.

| Paying agencies | Monthly revenue | Monthly cost | Monthly result |
|---|---|---|---|
| 10 | ₹35,000 | ₹1,05,000 | about -₹70,000 |
| 25 | ₹87,500 | ₹1,12,500 | about -₹25,000 |
| 35 | ₹1,22,500 | ₹1,17,500 | about break-even |
| 50 | ₹1,75,000 | ₹1,25,000 | about +₹50,000 |
| 100 | ₹3,50,000 | ₹1,50,000 | about +₹2,00,000 |

So operating break-even is roughly **30-40 paying agencies** at these assumptions, and the one-time investment is recovered after that. If maintenance is handled by the founders rather than paid, break-even comes much sooner. If prices are higher or the mix skews to Growth/Pro, it moves earlier; if acquisition is slow or support-heavy, later. Customer acquisition cost is **not** included.

## 6. Risks to the numbers
- Meta pricing changes often (the 1 October 2026 change is recent). Re-check before each price review.
- Real-world Cloud API integration may take longer than estimated (it is unverified live).
- Support load per agency in the first month is usually higher than expected.
- Churn, discounts and free pilots reduce effective revenue.
- GST registration, invoicing and TDS rules apply to the business itself; take professional advice.

## 7. Sources checked
- Meta for Developers, WhatsApp pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- Meta for Developers, service and utility message pricing update: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages
- WhatsApp Business pricing overview (note: its summary was out of date on service messages): https://whatsappbusiness.com/products/platform-pricing/
- Third-party India rate summaries (rates differ between them; verify against Meta's CSV): https://aisensy.com/pricing, https://myoperator.com/blog/whatsapp-business-api-pricing-india-2026
