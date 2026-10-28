# GreenRev Business Suite

SaaS back office for the automotive businesses on [greenrevs.com](https://greenrevs.com): **car dealers, mechanics, spare-parts vendors, haulage operators and car rentals**. It provides inventory, operations and a full double-entry accounting package. Stock is linked to the GreenRev marketplace, so anything a business manages here can be listed there automatically.

The suite is an API-first module (TypeScript · Fastify · PostgreSQL), built to merge into the existing GreenRev web and mobile apps:

- users sign in with their GreenRev account (SSO)
- inventory syncs to the marketplace through an outbox
- buyer enquiries flow back through signed webhooks

## What's inside

| Area | Features |
|---|---|
| **Inventory** | Vehicles (VIN, specs, photos, status, branch), parts & accessories (SKU, part number, compatibility, reorder levels), stock movements, weighted-average cost, stock-count write-offs, plan limits |
| **Import & landed cost** | Buy in USD/GBP/EUR/… at the day's rate; duty, clearing, shipping and reconditioning are capitalised per car into a naira **landed cost** |
| **Sales (AR)** | Invoices and receipts, line and invoice discounts, settlement (early-payment) discounts, 7.5% VAT, auto-allocation to oldest invoices, customer deposits, statements |
| **Installments** | Hire-purchase plans: down payment, weekly/monthly schedule, flat interest, payments applied in order, overdue collections list |
| **Payables (AP)** | Supplier bills (foreign currency), part-payments, discounts received, **realised FX gain/loss**, supplier advances |
| **Expenses & VAT** | Expenses per vehicle, trip or job card; input VAT; VAT return helper (output − input) for FIRS |
| **Reports** | P&L, balance sheet (statement of financial position), direct-method cash flow, trial balance, general ledger, AR/AP aging, profit per car, monthly analytics, top models, slow movers, dashboard |
| **Mechanics** | Job cards (complaint → diagnosis → labour & parts → invoice), parts issued from stock at cost |
| **Haulage** | Fleet (car carriers, trucks, tow trucks), trips with waybills, trip expenses, trip invoice, profit per truck |
| **Rentals** | Rental fleet (as fixed assets), bookings with **database-enforced no double-booking**, security deposits, check-out/in mileage, late and damage fees, utilisation |
| **Marketplace link** | Auto-publish in-stock cars and parts to greenrevs.com, auto-unlist on sale, retrying outbox, buyer leads via webhook → CRM contact |
| **Smart AI** (Claude) | VIN camera scanner, photos → pre-filled vehicle record, listing writer, receipt/customs-assessment reader → draft expense/bill, spare-part identification; metered monthly credits |
| **SaaS** | Multi-tenant orgs, roles (owner/admin/accountant/sales/mechanic/dispatcher/viewer), team invites, two packages, Paystack subscriptions |

## The two packages

| | **Starter** ₦15,000/mo | **Pro** ₦45,000/mo |
|---|---|---|
| Business lines | 1 (dealer *or* mechanic *or* parts *or* haulage *or* rental) | All, combined |
| Users | 3 | 25 |
| Active vehicles / parts | 50 / 1,000 | Unlimited |
| Inventory, invoices, receipts, expenses, VAT, P&L, profit per car, analytics | ✓ | ✓ |
| Marketplace publishing & leads | ✓ | ✓ |
| AI credits / month | 50 | 1,000 |
| Supplier bills on credit, AP aging | – (cash purchases only) | ✓ |
| Foreign-currency purchases & FX gain/loss | – | ✓ |
| Installment plans | – | ✓ |
| Balance sheet, cash flow, trial balance, ledger, AR aging | – | ✓ |

Prices and limits live in `src/modules/billing/plans.ts`. Gated endpoints return `402 upgrade_required` with `details.upgradeTo`, so the app can show an upgrade prompt.

## Run it

```bash
cp .env.example .env            # set JWT_SECRET, ANTHROPIC_API_KEY, Paystack + GreenRev values
docker compose up -d db         # or any PostgreSQL 14+
npm install
npm run migrate
npm run dev                     # http://localhost:4000, API docs at /docs
```

Tests run end-to-end against a real PostgreSQL database (`greenrev_suite_test` by default, override with `DATABASE_URL`):

```bash
npm test
npm run typecheck
```

## Conventions

- **Money is integer kobo** everywhere in the API (₦1,000 = `100000`). Foreign amounts are minor units of their currency (cents) next to `currency` + `fxRate` (NGN per unit).
- Rates are basis points: `750` = 7.5%.
- Every request is scoped to the caller's organisation (`org` claim in the token, or the `X-Org-Id` header for multi-business users).
- Every money movement posts a balanced journal entry. A deferred PostgreSQL constraint trigger rejects any unbalanced entry at commit.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): modules, data model, accounting posting rules
- [docs/INTEGRATION.md](docs/INTEGRATION.md): merging with the GreenRev app: SSO, marketplace API contract, webhooks, frontend
- [docs/ROADMAP.md](docs/ROADMAP.md): what's next
- Live OpenAPI / Swagger UI at `/docs` (JSON at `/docs/json`): generate a typed client for the web and mobile apps from it
