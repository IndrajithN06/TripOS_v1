# TripOS V1

Multi-tenant SaaS for travel agencies: WhatsApp enquiry, branded quotation with vehicle photos, versioned negotiation, pipeline dashboard.

- **Status:** implemented and tested locally; **not deployed**. Production deployment awaits explicit owner approval.
- **Stack:** Next.js 15 · NestJS · PostgreSQL (RLS) · pure decimal pricing library · provider adapters (storage / WhatsApp / AI / email).

Quick start: see [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md).

```bash
npm install && docker compose up -d && npm run build:pricing && npm run db:migrate && npm run db:seed && npm run dev
```

| Doc | Purpose |
|---|---|
| [PRODUCT_REQUIREMENTS](docs/PRODUCT_REQUIREMENTS.md) | what is built and the business rules |
| [TECHNICAL_ARCHITECTURE](docs/TECHNICAL_ARCHITECTURE.md) | design, tenancy, providers |
| [IMPLEMENTATION_PLAN](docs/IMPLEMENTATION_PLAN.md) | phases, status, remaining work |
| [DECISIONS_AND_ASSUMPTIONS](docs/DECISIONS_AND_ASSUMPTIONS.md) | decisions, assumptions, open questions |
| [LOCAL_DEVELOPMENT](docs/LOCAL_DEVELOPMENT.md) | setup, accounts, commands |
| [PRODUCTION_DEPLOYMENT](docs/PRODUCTION_DEPLOYMENT.md) | prepared (unexecuted) deployment plan |
| [TESTING_AND_ACCEPTANCE](docs/TESTING_AND_ACCEPTANCE.md) | real results, limitations, acceptance checklist |
