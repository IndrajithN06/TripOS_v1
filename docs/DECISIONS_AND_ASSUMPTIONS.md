# Decisions and Assumptions

## Decisions made (with reasons)
- **D-1 V1 scope.** The V1 architecture document explicitly limits V1; the larger Product Spec (bookings, trips, finance, drivers, Google Ads) is treated as the roadmap. Not built.
- **D-2 Stack.** Fresh Next.js + NestJS in `TripOS_v1`, as chosen by the product owner. The earlier .NET/Angular repo (`TravelCRMAgency`) is untouched and unused here.
- **D-3 Tenant isolation.** App-level scoping plus PostgreSQL RLS with a non-superuser runtime role.
- **D-4 Queue.** Postgres-backed queue instead of Redis/BullMQ (no extra infrastructure; same retry/backoff semantics). Swap behind `JobsService` if volume demands.
- **D-5 Realtime.** 4-second polling instead of SSE/WebSockets. Simple and reliable for V1 volume; upgrade later.
- **D-6 Images.** JPEG/PNG only (PDF renderer limitation; verified by magic bytes), 5 MB, max 12 per vehicle type.
- **D-7 Version lock point.** A quote version locks when the first item of it is accepted by the provider. If every item fails, the version stays an editable draft (the customer received nothing).
- **D-8 Money formatting.** Money is serialised with 2 decimals everywhere in the quote API.
- **D-9 PDF currency.** The PDF prints `INR 1,234.00` because the built-in PDF font has no rupee glyph.

- **D-10 Failure alert definition.** A failed outbound message counts on the dashboard only until a later outbound message in the same conversation is accepted.
- **D-11 Invites and resets.** One mechanism: single-use, 72 h set-password links (stored hashed). "Reset password" issues a new link without locking the user out until it is used; using any link revokes existing sessions.
- **D-12 Profile freshness.** The app shell re-fetches the profile after branding changes and every 4 minutes (signed logo URLs live about 5 minutes).
- **D-13 Dashboard scope.** Sales users see only their own quotes and no pipeline value; failure alerts are agency-wide.
- **D-14 Analytics charts.** Hand-written SVG instead of a charting library (no dependency, full control of accessibility and theme). Categorical palette limited to three series, validated against the card surface.

## Business assumptions (confirm before production)
| # | Assumption | Default implemented |
|---|---|---|
| A-1 | Discount vs tax order | Discount before tax. Tax only on lines marked taxable. |
| A-2 | Tax | Per-agency rate and inclusive/exclusive. Nothing hard-coded. Off by default. |
| A-3 | Rounding | Half-up, 2 dp, per line and for tax. |
| A-4 | Min-km rule | Trip-wide (days x min km/day) in the UI; per-day mode exists in the API/pricing library but the UI option is disabled (needs per-day km entry). |
| A-5 | Sales visibility | Agency setting: all, or assigned/own only. Default all. |
| A-6 | Follow-ups | Set manually per quote. No automatic default or reminder delivery yet. Due items show in the dashboard/list. |
| A-7 | Quote validity | Agency setting, default 7 days; expired sweep every 10 min. |
| A-8 | Customer-facing format | Branded PDF + text summary + selected photos as separate image messages. |
| A-9 | Service window | Free-form messages only within 24 h of the customer's last message; otherwise an approved template. |
| A-10 | Rate overrides | Admin always; Sales only if `canOverrideRates`. Discounts are treated as rate changes. |
| A-11 | AI cost estimate | Illustrative per-token USD rates in `AiService.record`; set from the real provider price sheet before relying on it. |
| A-12 | Retention | Not defined by the documents. Nothing is auto-deleted. Messages/media are kept; vehicle photos used in sent quotes are never deleted. Define policy before launch. |

## Open decisions needing the product owner
1. Meta Cloud API directly vs a BSP (affects onboarding, pricing, template management).
2. Hosting region and data retention/privacy policy.
3. Default tax treatment per agency type (inclusive vs exclusive).
4. Follow-up due rules and who is notified.
5. Whether quote totals should be tax-inclusive by default.
