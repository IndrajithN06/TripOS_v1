# Testing and Acceptance

## Results actually observed (2026-10-10, Windows, Node 22, PostgreSQL 16 in Docker)
| Check | Command | Result |
|---|---|---|
| Typecheck (all packages) | `npm run typecheck` | no errors |
| Pricing unit tests | `npm test` | 14 / 14 passed |
| API unit tests (config safety, crypto, upload sniffing, webhook signature/parse, templates) | `npm test` | 21 / 21 passed |
| API integration/e2e (isolation, permissions, vehicles, enquiry, quotes, versioning, delivery/retry, templates, window, AI, dashboard, ops) | `npm run test:e2e` | 48 / 48 passed |
| Production build (pricing, API, Next.js) | `npm run build` | succeeded |
| `db:reset` + seed | `npm run db:reset` | succeeded |
| Live smoke (API + web via proxy: login, 6 pages, dashboard, quotes) | manual curl | all OK |
| Dependency audit | `npm audit` | **not run**: registry audit endpoint returned an error |

## Scenario coverage
| # | Scenario | Where |
|---|---|---|
| 1 | Agency isolation (read, write, lists, payload refs, media URLs, direct RLS) | `isolation.e2e-spec.ts` |
| 2 | Onboarding via Super Admin + invites | `isolation` / `helpers.onboard` |
| 3 | Vehicle config, rates, upload/reorder/primary/remove, archive, bad uploads | `workflow` |
| 4 | Simulated enquiry, dedupe, assignment, notes, search | `workflow` |
| 5 | Quote from conversation with selected photos, preview, PDF | `workflow` |
| 6 | Backend-authoritative totals; manipulated input rejected | `workflow`, pricing unit tests |
| 7 | Versioning; v1 + PDF unchanged; DB trigger blocks raw SQL edits | `workflow` |
| 8 | Duplicate webhooks, retry, partial media failure, forward-only statuses, idempotency | `workflow` |
| 9 | AI outage/kill switch/limits; injection text cannot price or send | `workflow` |
| 10 | Sales/Admin/Super Admin permission boundaries | `isolation` |
| 11 | Production config refuses unsafe fallbacks | `config.spec.ts` |
| 12 | Build/typecheck/tests | table above |

## Not verified / limitations (be aware before approving)
- **No live provider has been exercised.** Meta Cloud API, S3, OpenAI and Resend adapters are written but untested against the real services. The WhatsApp simulator is not proof of a working Meta integration.
- **Meta template submission/status sync** is not implemented (the simulator mimics states; in `cloud` mode submission returns a clear "not implemented").
- **No browser-automated UI tests** (Playwright) and **no accessibility audit**. The UI was built with labels/roles/keyboard handling, and compiled and smoke-tested via HTTP, but not clicked through by an automated browser here.
- Real-time updates use polling, not SSE/WebSockets.
- MFA has API endpoints and production enforcement, but no UI screen.
- No self-service password reset (a Super Admin can re-invite an agency admin; admins can disable users).
- Per-day minimum-km mode exists in the API, but the UI option is disabled.
- PDF footer prints only on the last page; PDF shows "INR" instead of the rupee symbol.
- `npm audit`, Docker image builds, and load/performance testing were not run.
- Retention and consent policy undefined (DECISIONS A-12).

## Local acceptance checklist (for you)
1. `docker compose up -d`, `npm install`, `npm run db:migrate`, `npm run db:seed`, `npm run dev`; open http://localhost:3100.
2. Sign in as `superadmin@tripos.local`; create two agencies; open their invite links (shown on screen) and set passwords.
3. As each agency admin: upload a logo + brand colour; add a vehicle type with both slabs, outstation rate, batta; upload 3 photos; reorder; set primary; archive/restore.
4. Settings → WhatsApp → Connect (simulated); Settings → Team → invite a sales user.
5. As sales: Inbox → simulator panel → *Receive text*; open the chat; **New quote**; pick vehicle and 2 photos; watch the total update; **Save & preview**; **Send via WhatsApp**.
6. Use *Fail next image* then send; confirm "partially sent", then **Retry failed items only**; confirm nothing was duplicated.
7. Edit/Requote with a discount; confirm v2 is created and v1 (PDF, total) is unchanged; use **Compare**.
8. Mark the quote accepted manually; check the Dashboard figures against the Quotes list.
9. Sign in as the other agency and confirm none of the first agency's data is visible; sign in as sales and confirm Settings is absent.
10. Turn off AI (kill switch as Super Admin) and confirm the inbox and quoting still work.
11. Run `npm test` and `npm run test:e2e`.
