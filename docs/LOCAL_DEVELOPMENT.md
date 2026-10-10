# Local Development

## Prerequisites
Node 20+ (tested on 22), npm 10+, Docker (for PostgreSQL). No paid services are needed.

## First-time setup
```bash
npm install
docker compose up -d                       # PostgreSQL 16 on localhost:5442 (also creates the non-superuser app role)
cp apps/api/.env.example apps/api/.env     # already provided for dev; contains only dev placeholders
npm run build:pricing
npm run db:migrate                         # applies migrations (tables, RLS, constraints, triggers)
npm run db:seed                            # two synthetic agencies + a super admin
npm run dev                                # API :4100 and web :3100
```
Open http://localhost:3100.

## Ports
| Service | URL |
|---|---|
| Web | http://localhost:3100 |
| API | http://localhost:4100 (`/health`, `/health/ready`) |
| PostgreSQL | localhost:5442 (owner `tripos`, app role `tripos_app`) |

## Development accounts (password for all: `DevPassword!123`, dev only)
| Role | Email |
|---|---|
| Super Admin | superadmin@tripos.local |
| Agency A admin / sales | admin@golden.test / sales@golden.test |
| Agency B admin / sales | admin@lakshya.test / sales@lakshya.test |

You can also create agencies yourself: sign in as Super Admin, **Create agency**; in development the invite link is shown on screen and in the API log (email provider = console).

## Simulated WhatsApp
In the Inbox, the right panel shows a **WhatsApp simulator** (clearly labelled SIMULATED): receive a text/photo enquiry, make the next image/PDF/text send fail, run the job queue; hover outgoing messages for "sim delivered / sim read". Messages are stored with `simulated = true` and labelled in the UI. Nothing leaves your machine.

## Commands
| Command | Purpose |
|---|---|
| `npm run dev` | API + web with reload |
| `npm run typecheck` / `npm run lint` | TypeScript checks (lint = typecheck) |
| `npm test` | pricing + API unit tests |
| `npm run test:e2e` | API integration tests (uses separate DB `tripos_test`, created automatically) |
| `npm run build` | production build of all packages |
| `npm run db:seed:history -w @tripos/api` | adds ~45 days of synthetic backdated activity so the analytics dashboard has data (dev only, idempotent) |
| `npm run db:reset` | **Destroys dev data**: drops, re-migrates, re-seeds the dev database |
| `docker compose down -v` | remove PostgreSQL and its data volume |

## Resetting test data
`npm run db:reset` (dev DB). Uploaded files live in `apps/api/storage` (delete the folder to clear them). The e2e database is created per-run and uses unique slugs, so it needs no cleanup.

## Troubleshooting
- *Port 5442 in use*: change the mapping in `docker-compose.yml` and both URLs in `apps/api/.env`.
- *`permission denied` / RLS errors*: ensure `DATABASE_URL` uses `tripos_app` (non-superuser) and migrations ran with `DATABASE_MIGRATE_URL`.
- *Login 403 "csrf"*: call the API through the web proxy (`/api/...`) or send header `x-tripos-csrf: 1`.
- *API refuses to start*: the message lists each unsafe or missing environment setting.
- *Docker volume created before `docker/init.sql` existed*: `docker compose down -v` and start again.
