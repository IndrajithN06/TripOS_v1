# TripOS V1

Multi-tenant SaaS for travel agencies: WhatsApp enquiry, branded quotation with vehicle photos, versioned negotiation, analytics dashboard.

- **Status:** implemented and tested locally; **not deployed**. Real WhatsApp integration is waiting on Meta approval. Production deployment requires explicit owner approval.
- **Stack:** Next.js 15 · NestJS · PostgreSQL with row-level security · pure decimal pricing library · provider adapters (storage / WhatsApp / AI / email).

Quick start (details in [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md)):
```bash
npm install && docker compose up -d && npm run build:pricing && npm run db:migrate && npm run db:seed && npm run dev
npm run db:seed:history -w @tripos/api   # optional: demo data for the dashboard
```
Web http://localhost:3100 · API http://localhost:4100

## Documentation
| Read this | If you want to know |
|---|---|
| [BUSINESS_GUIDE](docs/BUSINESS_GUIDE.md) | what the product does, roles, daily workflow, pricing rules, dashboard definitions, FAQ |
| [PRODUCT_REQUIREMENTS](docs/PRODUCT_REQUIREMENTS.md) | exactly what V1 includes and excludes |
| [TECHNICAL_ARCHITECTURE](docs/TECHNICAL_ARCHITECTURE.md) | design, tenancy, providers, web app, repository layout |
| [DATA_MODEL](docs/DATA_MODEL.md) | every table, constraint and trigger |
| [API_REFERENCE](docs/API_REFERENCE.md) | every endpoint, role, error code |
| [SECURITY_AND_OPERATIONS](docs/SECURITY_AND_OPERATIONS.md) | controls, risks, secrets, runbooks, tenant-table checklist |
| [LOCAL_DEVELOPMENT](docs/LOCAL_DEVELOPMENT.md) | setup, accounts, commands, troubleshooting |
| [WHATSAPP_GO_LIVE](docs/WHATSAPP_GO_LIVE.md) | step-by-step first real Meta test |
| [PRODUCTION_DEPLOYMENT](docs/PRODUCTION_DEPLOYMENT.md) | prepared, unexecuted deployment plan |
| [TESTING_AND_ACCEPTANCE](docs/TESTING_AND_ACCEPTANCE.md) | real test results, limitations, acceptance checklist |
| [DECISIONS_AND_ASSUMPTIONS](docs/DECISIONS_AND_ASSUMPTIONS.md) | decisions made, business assumptions, open questions |
| [IMPLEMENTATION_PLAN](docs/IMPLEMENTATION_PLAN.md) | phase status and what changed since |
| [ROADMAP](docs/ROADMAP.md) | finishing V1, future phases, extension rules |
