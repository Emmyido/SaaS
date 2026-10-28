# Merging with the GreenRev app

The Business Suite runs as its own service (`api.greenrevs.com/suite` or similar) next to the marketplace. Integration needs three pieces of work on the existing GreenRev side, and each is small.

## 1. Single sign-on

GreenRev already has user accounts, so it should not need a second login. The existing GreenRev backend mints a short-lived HS256 JWT signed with a shared secret (`GREENREV_SSO_SECRET`):

```json
{ "sub": "<greenrev user id>", "email": "ada@example.com", "name": "Ada Okafor", "phone": "+234...", "exp": 1767225600 }
```

The app exchanges it for a Business Suite token:

```http
POST /auth/greenrev
{ "token": "<greenrev jwt>" }
→ { "token": "<suite token>", "user": {...}, "organizations": [...], "needsOnboarding": true }
```

The first exchange creates the suite user, or links an existing one by email. When `needsOnboarding` is true, show a "Set up your business" screen that calls `POST /auth/organizations` with the business name and lines (dealer, mechanic, parts_vendor, haulage, rental).

To migrate to asymmetric keys later, replace `verifyGreenRevToken()` in `src/modules/auth/service.ts`.

## 2. Marketplace listings API (implemented by greenrevs.com)

The suite pushes stock to the marketplace. Set `GREENREV_MARKETPLACE_URL` and `GREENREV_MARKETPLACE_API_KEY`. Without them the suite runs a log-only adapter. The marketplace needs to expose:

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/v1/listings` | `MarketplaceListing` | `{ "id": "<listing id>", "url": "https://greenrevs.com/cars/..." }` |
| `PUT` | `/v1/listings/:id` | `MarketplaceListing` | `{ "id": "...", "url": "..." }` |
| `DELETE` | `/v1/listings/:id` | – | `204` (a `404` is treated as already removed) |

Authentication is `Authorization: Bearer <GREENREV_MARKETPLACE_API_KEY>`. The listing shape is `MarketplaceListing` in `src/modules/marketplace/adapter.ts`:

```json
{
  "externalId": "b8c1…",                 // suite item id: use it as the idempotency key
  "sellerId": "gr_seller_123",           // organizations.greenrev_seller_id (set in Settings)
  "seller": { "name": "Ada Motors", "phone": "+234…", "whatsapp": "+234…", "city": "Lagos", "state": "Lagos", "logoUrl": null },
  "type": "vehicle",
  "title": "2019 Lexus RX 350",
  "description": "…",
  "priceNgn": 2600000000,                // kobo
  "currency": "NGN",
  "status": "available",                 // available | in_transit | reserved
  "photos": ["https://…"],
  "vehicle": { "make": "Lexus", "model": "RX 350", "year": 2019, "mileageKm": 64000, "condition": "foreign_used", "vinLast6": "123456", … },
  "attributes": { "highlights": ["…"], "tags": ["…"] },
  "updatedAt": "2026-04-01T10:00:00.000Z"
}
```

Parts use `type: "part" | "accessory"` with a `part` object (`partNumber`, `brand`, `compatibleWith`, `quantityAvailable`).

Upserts are idempotent: the suite always sends the item's full current state. If the marketplace already stores listings created directly on greenrevs.com, set `organizations.greenrev_seller_id` and match on `externalId` to avoid duplicates.

## 3. Webhooks from the marketplace

When a buyer taps *Enquire on WhatsApp* or sends a message, or when moderation removes a listing, POST to the suite:

```http
POST /webhooks/greenrev
X-GreenRev-Signature: sha256=<hex HMAC-SHA256 of the raw body with GREENREV_WEBHOOK_SECRET>

{ "type": "lead.created", "data": { "listingId": "…", "buyerName": "Emeka", "buyerPhone": "+234…", "message": "Still available?", "channel": "whatsapp" } }
{ "type": "listing.removed", "data": { "listingId": "…", "reason": "Duplicate" } }
```

Leads appear under `GET /leads` and on the dashboard. A lead can be converted to a customer contact, then to an invoice.

## 4. Frontend

The API is fully described by OpenAPI at `/docs/json`. Generate a typed client for the existing apps, for example `npx openapi-typescript http://localhost:4000/docs/json -o greenrev-suite.d.ts` for the web app, or the Dart/Kotlin/Swift generators for mobile. Suggested screens, in build order:

1. Onboarding (business lines, plan), dashboard (`/dashboard`)
2. Inventory list and vehicle form with **Scan VIN** (`/ai/vin-scan`) and **Add from photos** (`/ai/vehicle-intake`)
3. Sell (invoice + receipt, optional installment plan), customer list and statement
4. Expenses with **Snap receipt** (`/ai/document`), bills and supplier payments
5. Reports (P&L, profit per car, VAT, balance sheet, cash flow, aging)
6. Vertical screens: job cards, trips, rental calendar (`/rentals/availability`)
7. Settings: team, FX rates, marketplace auto-publish, billing (`/billing/checkout`)

Gated features return `402` with `{ "error": "upgrade_required", "details": { "upgradeTo": "pro" } }`. Render these responses as an upgrade sheet rather than an error.

## 5. Billing

Create two Paystack plans (Starter, Pro) and set `PAYSTACK_PLAN_STARTER` / `PAYSTACK_PLAN_PRO`. Point the Paystack webhook at `/webhooks/paystack`. `POST /billing/checkout` returns the Paystack `authorizationUrl`. New businesses get a 14-day trial on the plan they chose.

## 6. Deployment notes

- One PostgreSQL database (14+). Migrations run on start (`node dist/db/migrate.js`), or with `npm run migrate`.
- Uploads go to local disk by default (`UPLOAD_DIR`). For production, swap `src/lib/storage.ts` for S3/Cloudinary, or the CDN the marketplace already uses. Documents (receipts, customs assessments) should go to a private bucket.
- Run the outbox worker in-process (`RUN_WORKER_IN_PROCESS=true`) or as a separate `npm run worker` container.
