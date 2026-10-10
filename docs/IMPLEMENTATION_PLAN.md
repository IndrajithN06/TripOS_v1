# Implementation Plan and Status

| Phase | Scope | Status |
|---|---|---|
| 0 Audit & plan | Read both documents + HTML reference; chose stack; docs | Done |
| 1 Foundation | Monorepo, Postgres+RLS, auth, roles, audit, config validation, seed | Done |
| 2 Agency admin | Super Admin console, agencies, invites, users, branding, settings | Done |
| 3 Vehicle catalogue | Types, rate cards (append-only), multi-image upload/order/primary/caption, archive | Done |
| 4 Quote engine | Pure pricing lib, builder, tax/discount, preview, PDF, immutable versions, statuses, diff | Done |
| 5 Inbox | Conversations, thread, simulator, notes, assignment, statuses | Done (polling, not SSE) |
| 6 Chat-to-quote delivery | Photo selection, send PDF+photos, requote, partial failure + per-item retry | Done |
| 7 Real providers | Meta Cloud, S3, OpenAI, Resend adapters written | Written, **unverified live** |
| 8 AI & templates | Extract/summary/reply/negotiation/draft; template drafts + provider states; limits, kill switch | Done (mock tested); Meta template submission not implemented |
| 9 Dashboard/UX | Metrics, filters, activity, loading/empty/error states | Done |
| 10 Hardening | Isolation/permission/failure tests, production build | Done for API; no browser E2E |
| 11 Approval checkpoint | Report and wait | **Reached; awaiting your approval** |

## Remaining work (not done)
Browser E2E (Playwright), accessibility audit, SSE/WebSocket, Meta template submission/sync API calls, MFA enrolment screen, password-reset (admin re-invite exists), PDF footer on every page, UI for per-day minimum km, dependency vulnerability remediation, live provider verification, Docker image build verification, load/pagination performance testing.
