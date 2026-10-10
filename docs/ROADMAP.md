# Roadmap and Future Development

This separates **finishing V1 for real use** (near-term) from **growing the product** toward the full vision in the *TripOS Developer Product & Business Logic Specification* (later phases). Items are ordered by dependency, not by calendar commitment. Nothing here is built unless `IMPLEMENTATION_PLAN.md` says so.

## A. Finish V1 for real use (near-term)
| ID | Item | Why | Notes |
|---|---|---|---|
| R1 | **Meta template submission and status sync** | Templates are required outside the 24 h window; status must come from Meta, not be hand-set | Call the WABA message-template endpoints; poll or subscribe to template-status webhooks; map to `providerStatus`. Blocks real template use. |
| R2 | **Live verification of the Cloud adapter** | Written, never run against Meta | Follow `WHATSAPP_GO_LIVE.md`; fix payload, media and error-mapping differences. Depends on Meta approval. |
| R3 | **Live verification of S3, OpenAI, Resend adapters** | Same reason | Add an SMTP adapter if a non-Resend sender is preferred. |
| R4 | **Embedded Signup** | Agencies connect their own number without pasting IDs/tokens | Needs Meta app review for tech-provider permissions. |
| R5 | **Realtime inbox (SSE or WebSocket)** | Polling every 4 s is fine for V1 volume, not for scale | Tenant-scoped subscriptions; reuse the same authorisation as the REST endpoints. |
| R6 | **Browser E2E tests (Playwright) and accessibility audit** | Only API tests and manual screenshots exist | Cover onboarding, quote send/requote, branding refresh, dashboard; axe checks. |
| R7 | **Self-service password reset, MFA enrolment screen** | Admin-issued links exist; MFA has API only | Super Admin MFA is enforced in production once enrolled. |
| R8 | **Monitoring, alerting, backups, restore test** | Required before real traffic | Error tracking, uptime on `/health/ready`, alert on failed `Job` rows and webhook errors, PITR, documented restore drill. |
| R9 | **Retention, consent and deletion policy** | Not defined in the specs | Per-agency retention, customer data export/erase, privacy notice; keep audit and sent-quote history intact. |
| R10 | **Follow-up reminders** | Follow-up dates exist but nothing notifies anyone | Define who is reminded (open decision); in-app and optional WhatsApp/email digests. |
| R11 | **Quality polish** | Known small gaps | Per-day minimum-km entry in the UI; PDF footer on every page and a font with the ₹ glyph; inbound media gallery and audio playback; database-level foreign keys; `npm audit` remediation; Docker image build and run verification; load and pagination testing. |
| R12 | **Per-tenant rate limits and abuse controls** | Throttling is per client IP today | Limits keyed by agency and user. |

## B. Product phases beyond V1
These come from the long-term specification. Each phase keeps the rules in §D.

| Phase | Scope | Main additions |
|---|---|---|
| **P2 Customer quote page** | Mobile-first public quote page, **customer acceptance** that records *option + version*, PDF and share link | Signed, unguessable public links; acceptance event with audit; multiple vehicle **options** inside one quote (the spec's "Option 1/2/3"). |
| **P3 Booking** | Accepted quote becomes a **Booking** (a commercial agreement) | Booking entity separate from Trip; advance/balance; cancellation policy and reasons. |
| **P4 Operations** | **Trip** execution: vehicles, drivers, assignment, readiness | Vehicle and driver registries; availability; **PostgreSQL exclusion constraints** to prevent overlapping vehicle or driver assignments; driver confirmation over WhatsApp; readiness checklist; incidents and replacement history. |
| **P5 Driver portal** | Mobile-first driver view | Today's trip, arrive/start/end, odometer, expense uploads, issue reporting. |
| **P6 Finance** | **Final bill** (separate from the quote), payments, invoices, expenses | Actual km/hours vs quoted; payment links and reminders; receipts; **vendor cost kept separate from customer revenue**; margin. |
| **P7 Fleet** | Documents, maintenance, utilisation | Expiry alerts, service intervals, utilisation reports. |
| **P8 Automation** | WHEN → THEN rules | Booking confirmed, driver confirmed, trip tomorrow, payment overdue, document near expiry. |
| **P9 Marketing** | Google Ads and attribution | Lead source and campaign persisted from lead through revenue; spend, cost per lead/booking, ROAS. |
| **P10 AI operations** | Operational intelligence | Daily operations summaries and risk flags, still draft-only and tenant-scoped. |

Additional roles in the specification (Tenant Owner, Operations Manager, Accounts, Driver) arrive with the phases that need them; the current three-role model and `PERMISSIONS` map are the extension point.

## C. How to extend safely
- **New tenant table:** add `agencyId`, index it, add the table to the RLS list (see `SECURITY_AND_OPERATIONS.md` §5), grant the app role, and add an isolation test before shipping.
- **New integration:** define an interface under `apps/api/src/providers`, ship a local fake first, add a production adapter selected by environment, and extend `validateConfig` so production cannot silently use the fake.
- **New pricing rule:** add it to `packages/pricing` as pure logic with unit tests; the API only calls the library. Never compute money in the web app or in AI code.
- **Money:** decimals only; `numeric(18,2)` in the database.
- **Anything customer-facing and AI-generated** stays a staff-approved draft.
- **Scaling path:** the modular monolith can split later along existing module lines. Swap the Postgres queue for BullMQ/SQS behind `JobsService`; move the worker to its own process; add read replicas for analytics if dashboard queries grow.

## D. Rules carried forward (from the specifications)
1. No hard-coded tenant, rate, slab, minimum-km, batta or tax values.
2. Money is decimal; never float.
3. Tenant identity comes from the authenticated principal, never request input; isolation is enforced server-side and in the database.
4. Sent quote versions are immutable; edits create a new version; acceptance names option and version.
5. **Booking ≠ Trip. Quote ≠ Final bill.** Customer revenue and vendor cost are separate records.
6. Vehicle and driver overlap is prevented by database constraints, not only application checks.
7. Pricing is a pure library with no I/O, clock or global state.
8. Timestamps are UTC, displayed in the agency timezone.
9. External services only through interfaces with local fakes; production refuses fakes.
10. Critical actions are audited.

## E. Open decisions that gate roadmap items
Meta directly vs a BSP (R1, R2, R4) · hosting region and retention (R8, R9) · default tax treatment · follow-up rules and recipients (R10) · whether the customer quote page needs online payment at launch (P2, P6).
