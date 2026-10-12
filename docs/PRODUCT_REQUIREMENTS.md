# TripOS V1: Product Requirements (as implemented)

Sources: *TripOS V1 Product Requirements & Technical Architecture* (docx, 10 Oct 2026), *TripOS Developer Product & Business Logic Specification* (docx/pdf), and the `tripos_v1.html` UI reference. The V1 architecture document defines the V1 scope; the broader specification is the long-term vision (see DECISIONS D-1).

## Scope
A multi-tenant SaaS in which a travel agency receives a WhatsApp enquiry, prepares a quotation from its own configured vehicle rates, sends a branded PDF plus selected vehicle photos, negotiates by issuing new immutable versions, and tracks the pipeline.

**Out of scope (not built):** dispatch, driver/vehicle registration, trip execution, bookings, billing/accounting, payments, Google Ads, a general CRM.

## Roles
| Capability | Super Admin | Agency Admin | Sales |
|---|---|---|---|
| Create/suspend agencies, invite first admin, usage/errors, AI kill switch | yes | no | no |
| Agency chats & quotes | no (explicit, time-limited, audited grant only; metadata) | yes | yes (policy: all, or assigned/own) |
| Users, branding, WhatsApp connection, templates, tax, AI toggle | no | yes | no |
| Vehicle types, rates, photos | no | manage | read/select |
| Create/edit/send quotes | no | yes | yes (rate overrides/discounts gated per user) |
| Dashboard | platform usage | full | limited (own scope, no pipeline value) |

Enforced server-side (guards + tenant RLS); the UI only mirrors it.

## Screens (all implemented)
Dashboard, WhatsApp Inbox with in-chat Quote Builder, Quotes (list, detail, version history, diff), Vehicle Types (+ multi-photo manager), Settings (branding, team, WhatsApp, templates, quote/tax/AI, audit), Super Admin console.

## Quote rules
- Totals are computed only by the backend pricing library (`packages/pricing`), in decimals. AI never prices.
- Local packages (two configurable slabs + extra hour/km) and outstation (billable km = max(actual, days x min km/day); optional per-day mode in the API; driver batta/day).
- Extra named charges (taxable flag), discount (amount or %), tax (agency-configured rate; exclusive or inclusive).
- Order: lines, subtotal, discount, tax on (taxable lines minus discount), total. Rounding half-up to 2 dp per line.
- Each version stores the rate-card snapshot, inputs, lines, totals, branding/terms snapshot, selected photos and PDF.
- A version becomes immutable when the first message of it is accepted by the provider (enforced by a DB trigger). Editing a sent quote creates version N+1; v1 and its PDF stay byte-identical.
- Statuses: draft, ready_to_send, sent, negotiating, accepted, declined, expired, send_failed. Acceptance is manual; read receipts never change quote status.
- Send sequence: text, PDF, then each selected photo as its own image message. Per-item attempts; a failed photo is retried alone (idempotent, no duplicates).

## Dashboard definitions
New enquiries = conversations created in range. Open = not closed. Quotes created = parent quotes in range (versions reported separately). Awaiting = sent/negotiating, unexpired. Follow-ups due = those with follow-up at or before now. Accepted = manual status change to accepted in range. Pipeline value = sum of current-version totals of open quotes. Failures = failed/partially-sent versions + failed messages.
