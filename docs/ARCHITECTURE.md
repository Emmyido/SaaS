# Architecture

## Layout

```
src/
  app.ts                  Fastify app: plugins, error handling, public vs authenticated scopes
  index.ts / worker.ts    API process / standalone marketplace worker
  config.ts               Environment
  db/                     pg pool, tx() helper, SQL migrations (001_init.sql = whole schema)
  lib/                    money (kobo maths, allocation), dates, VIN decoder, storage, sequences, zod schemas
  plugins/context.ts      Auth → OrgContext {userId, orgId, role, plan, verticals}; role/feature/vertical guards
  modules/
    auth/                 email login, GreenRev SSO, invites, switch org
    orgs/                 organisation settings, members, FX rates, billing endpoints
    billing/              the two plans, Paystack checkout + webhook
    contacts/             customers & suppliers, statements
    inventory/            vehicles, parts, photos, stock costing (stock.ts)
    accounting/           chart, ledger, invoices, payments, bills, expenses, installments, fx, reports
    workshop/             job cards → invoices
    haulage/              fleet, trips → invoices, profit per truck
    rentals/              bookings, deposits, check-out/in → invoices, utilisation
    marketplace/          sync decision (sync.ts), outbox worker, HTTP adapter, inbound webhooks, leads
    ai/                   Claude wrapper (structured outputs, credits), VIN/photo/listing/document/part features
```

Services take a `Db` (pool or transaction client) and an `OrgContext`. Routes wrap writes in `tx()`, so a business change, its journal entry, its stock movement and its marketplace outbox row commit together or not at all.

## Multi-tenancy

Every table carries `org_id`. Every query filters on it, and every foreign record a request references (customer, item, account, bill …) is loaded with `org_id = ctx.orgId` before use. Cross-tenant reads return 404, and cross-tenant references return 400 (see `test/platform.test.ts`). Roles are checked in `preValidation`, before the body is parsed.

## Ledger

- `accounts`: per-org chart, seeded from `DEFAULT_CHART` (Nigerian automotive SME). Posting rules find accounts by `system_key` (`ar`, `vat_output`, `inventory_vehicles` …). Businesses can add their own accounts.
- `journal_entries` / `journal_lines`: debit/credit in kobo. Each line can carry `contact_id` and `item_id`, so the ledger alone can produce customer statements, deposit balances and per-car history.
- `postEntry()` validates the balance, and a deferred constraint trigger checks it again at commit. Voids post reversing entries; nothing is deleted from the ledger.
- AR and AP are control accounts. Manual journals cannot touch them, which keeps sub-ledgers (invoices, bills) and the ledger in agreement.

### Posting rules

| Event | Debit | Credit |
|---|---|---|
| Invoice | AR (total), Discounts Allowed | Revenue (gross per line), VAT Output |
| …vehicle line | Cost of Vehicles Sold (landed cost) | Inventory – Vehicles (or Fleet for rental cars) |
| …part line | Cost of Parts Sold (avg cost × qty) | Inventory – Parts |
| Customer receipt | Cash/Bank/POS, Discounts Allowed (settlement) | AR (allocated + discount), Customer Deposits (unallocated) |
| Apply deposit | Customer Deposits | AR |
| Installment interest | AR | Installment Interest Income |
| Supplier bill | Expense / Inventory (NGN at bill rate), VAT Input | AP (NGN at bill rate; foreign amount kept on the line) |
| Supplier payment | AP (carrying value), Supplier Advances | Bank (NGN at today's rate), Discounts Received, FX Gain *or* Dr FX Loss |
| Expense | Expense, or Inventory – Vehicles when capitalised; VAT Input | Cash/Bank |
| Opening stock | Inventory | Opening Balance Equity |
| Stock write-off | Stock Adjustments | Inventory – Parts |

**FX:** AP is carried at the bill-date rate. Each payment relieves AP at that carrying rate and converts the cash at the payment-date rate. The difference is realised FX gain or loss. `bills.ap_relieved_ngn` ensures the final payment clears exactly what is left, so no rounding dust is left on the bill.

**Landed cost:** `inventory_items.landed_cost_ngn` rises with every capitalised bill line or expense linked to a car and falls on void. When the car is sold, exactly that amount moves to cost of sales. After the sale, Inventory – Vehicles equals the sum of unsold cars' landed costs.

**Installments:** flat interest on the financed amount is recognised when the plan is agreed and added to the invoice as `finance_charges`. Money received against the invoice fills the schedule earliest-first. Overdue status is computed against the requested date.

## Reports

All reports are computed from the journal, not from documents. The P&L separates revenue, discounts, cost of sales, operating expenses and other income (interest, FX gain, discounts received). The balance sheet shows unclosed profit inside equity, so no year-end closing entry is required. The cash flow statement takes every entry that touched cash and splits it by its non-cash counterpart lines (operating / investing / financing), so the categories always reconcile to the change in cash. The tests assert `balanced` and `reconciles` on real scenarios.

## Marketplace sync

1. Any inventory change calls `queueMarketplaceSync()` inside the same transaction. It decides whether the item *should* be listed (in stock, has a price, publishing on) and upserts one pending outbox row per item.
2. The worker (in-process or `npm run worker`) claims due rows with `FOR UPDATE SKIP LOCKED`, rebuilds the listing from the item's current state, and calls the adapter. It retries with exponential backoff up to 8 attempts, and errors show on the item and in `/marketplace/status`.
3. Cost prices, supplier data and full VINs never leave the suite; listings carry the last 6 VIN characters only.

## AI

`modules/ai/claude.ts` wraps the Anthropic SDK:
- structured outputs validated by zod (`messages.parse` + `betaZodOutputFormat`)
- server-side refusal fallbacks (`fallbacks: "default"`)
- typed error mapping
- one credit per call, metered in `ai_usage` against the plan's monthly allowance

The model defaults to `claude-opus-5-5` (`AI_MODEL` env).

Each feature cross-checks the model against deterministic code where it can. VINs are OCR-normalised (O→0, I→1) and validated by check digit. The offline WMI decoder and the free NHTSA vPIC API override the model's guess of make and year when the VIN is valid. VIN-plate and document photos are never attached to public listings.

`StructuredModel` is an interface. Tests inject a fake, so the AI routes are covered without network calls.
