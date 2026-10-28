-- GreenRev Business Suite: initial schema.
-- Conventions:
--   * Every business table carries org_id (tenant) and is always queried with it.
--   * Money columns ending in _ngn, and plain amount/total columns, are BIGINT minor units (kobo).
--     Foreign-currency amounts sit next to their currency + fx_rate (NGN per 1 unit).
--   * Rates in basis points (_bp): 750 = 7.5%.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- tenancy

CREATE TABLE organizations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  verticals        TEXT[] NOT NULL DEFAULT '{dealer}',
  plan             TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter', 'pro')),
  plan_status      TEXT NOT NULL DEFAULT 'trialing' CHECK (plan_status IN ('trialing', 'active', 'past_due', 'cancelled')),
  plan_renews_at   TIMESTAMPTZ,
  paystack_customer_code TEXT,
  paystack_subscription_code TEXT,
  base_currency    TEXT NOT NULL DEFAULT 'NGN',
  vat_registered   BOOLEAN NOT NULL DEFAULT true,
  vat_rate_bp      INT NOT NULL DEFAULT 750,
  tin              TEXT,
  rc_number        TEXT,
  phone            TEXT,
  whatsapp         TEXT,
  email            TEXT,
  address          TEXT,
  city             TEXT,
  state            TEXT,
  logo_url         TEXT,
  auto_publish     BOOLEAN NOT NULL DEFAULT true,
  greenrev_seller_id TEXT UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT,
  full_name        TEXT NOT NULL,
  phone            TEXT,
  greenrev_user_id TEXT UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'accountant', 'sales', 'mechanic', 'dispatcher', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE invites (
  token      TEXT PRIMARY KEY,
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL,
  invited_by UUID REFERENCES users(id),
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-org document numbering (INV-000001, JOB-000001, ...)
CREATE TABLE sequences (
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key    TEXT NOT NULL,
  next   BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (org_id, key)
);

-- Daily FX rates the business uses (NGN per 1 unit of currency)
CREATE TABLE fx_rates (
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  currency   TEXT NOT NULL,
  rate_date  DATE NOT NULL,
  rate       NUMERIC(18, 6) NOT NULL CHECK (rate > 0),
  PRIMARY KEY (org_id, currency, rate_date)
);

-- ---------------------------------------------------------------- contacts

CREATE TABLE contacts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('customer', 'supplier', 'both')),
  name       TEXT NOT NULL,
  phone      TEXT,
  email      TEXT,
  address    TEXT,
  tin        TEXT,
  country    TEXT,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX contacts_org_idx ON contacts (org_id, kind);

-- ---------------------------------------------------------------- ledger

CREATE TABLE accounts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  -- cash | bank | receivable | inventory | fixed_asset | payable | tax | loan | deposit | cogs | other
  subtype    TEXT NOT NULL DEFAULT 'other',
  system_key TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  UNIQUE (org_id, system_key)
);

CREATE TABLE journal_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entry_no    BIGINT NOT NULL,
  entry_date  DATE NOT NULL,
  memo        TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_id   UUID,
  reverses_id UUID REFERENCES journal_entries(id),
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, entry_no)
);
CREATE INDEX journal_entries_org_date_idx ON journal_entries (org_id, entry_date);
CREATE INDEX journal_entries_source_idx ON journal_entries (org_id, source_type, source_id);

CREATE TABLE journal_lines (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id       UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id     UUID NOT NULL REFERENCES accounts(id),
  debit          BIGINT NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit         BIGINT NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description    TEXT,
  contact_id     UUID REFERENCES contacts(id),
  item_id        UUID,
  currency       TEXT,
  fx_rate        NUMERIC(18, 6),
  foreign_amount BIGINT,
  CHECK (debit = 0 OR credit = 0),
  CHECK (debit + credit > 0)
);
CREATE INDEX journal_lines_account_idx ON journal_lines (org_id, account_id);
CREATE INDEX journal_lines_entry_idx ON journal_lines (entry_id);

-- Database-level guarantee that every journal entry balances, checked at commit.
CREATE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE
  diff BIGINT;
  target UUID;
BEGIN
  target := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0) INTO diff FROM journal_lines WHERE entry_id = target;
  IF diff <> 0 THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced by % kobo', target, diff;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- ---------------------------------------------------------------- inventory

CREATE TABLE inventory_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('vehicle', 'part', 'accessory')),
  status             TEXT NOT NULL DEFAULT 'in_stock'
                     CHECK (status IN ('draft', 'in_transit', 'in_stock', 'reserved', 'in_repair', 'sold', 'rented', 'archived')),
  title              TEXT NOT NULL,
  sku                TEXT,
  branch             TEXT,
  description        TEXT,
  -- vehicle fields
  vin                TEXT,
  make               TEXT,
  model              TEXT,
  year               INT,
  trim               TEXT,
  body_type          TEXT,
  color              TEXT,
  mileage_km         INT,
  fuel_type          TEXT,
  transmission       TEXT,
  engine             TEXT,
  condition          TEXT CHECK (condition IN ('brand_new', 'foreign_used', 'nigerian_used')),
  plate_number       TEXT,
  -- costing (vehicles: landed cost = purchase + duty + capitalised expenses)
  purchase_currency  TEXT,
  purchase_amount    BIGINT,
  purchase_fx_rate   NUMERIC(18, 6),
  landed_cost_ngn    BIGINT NOT NULL DEFAULT 0,
  asking_price_ngn   BIGINT,
  min_price_ngn      BIGINT,
  -- parts / accessories
  part_number        TEXT,
  brand              TEXT,
  compatible_with    TEXT[] NOT NULL DEFAULT '{}',
  quantity           INT NOT NULL DEFAULT 0,
  reorder_level      INT NOT NULL DEFAULT 0,
  unit_cost_ngn      BIGINT NOT NULL DEFAULT 0,  -- weighted average cost
  unit_price_ngn     BIGINT,
  -- rentals
  is_rentable        BOOLEAN NOT NULL DEFAULT false,
  daily_rate_ngn     BIGINT,
  -- marketplace link
  publish_to_marketplace BOOLEAN NOT NULL DEFAULT true,
  marketplace_status TEXT NOT NULL DEFAULT 'unlisted' CHECK (marketplace_status IN ('unlisted', 'pending', 'listed', 'error')),
  marketplace_listing_id TEXT,
  marketplace_synced_at  TIMESTAMPTZ,
  marketplace_error  TEXT,
  attributes         JSONB NOT NULL DEFAULT '{}',
  supplier_id        UUID REFERENCES contacts(id),
  purchased_at       DATE,
  sold_at            DATE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inventory_items_vin_uq ON inventory_items (org_id, vin) WHERE vin IS NOT NULL AND status <> 'archived';
CREATE UNIQUE INDEX inventory_items_sku_uq ON inventory_items (org_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX inventory_items_org_kind_idx ON inventory_items (org_id, kind, status);
CREATE INDEX inventory_items_make_idx ON inventory_items (org_id, make, model);

CREATE TABLE item_photos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  item_id    UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  position   INT NOT NULL DEFAULT 0,
  ai_tags    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX item_photos_item_idx ON item_photos (item_id, position);

CREATE TABLE stock_movements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  item_id     UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  quantity    INT NOT NULL,
  unit_cost_ngn BIGINT NOT NULL DEFAULT 0,
  reason      TEXT NOT NULL CHECK (reason IN ('purchase', 'sale', 'job_card', 'adjustment', 'return', 'void')),
  source_type TEXT,
  source_id   UUID,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_item_idx ON stock_movements (item_id, created_at);

-- ---------------------------------------------------------------- sales (accounts receivable)

CREATE TABLE invoices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number           TEXT NOT NULL,
  customer_id      UUID NOT NULL REFERENCES contacts(id),
  issue_date       DATE NOT NULL,
  due_date         DATE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'partially_paid', 'paid', 'void')),
  subtotal         BIGINT NOT NULL,         -- gross before discounts
  discount_total   BIGINT NOT NULL DEFAULT 0,
  vat_total        BIGINT NOT NULL DEFAULT 0,
  total            BIGINT NOT NULL,         -- subtotal - discount + vat
  finance_charges  BIGINT NOT NULL DEFAULT 0,  -- installment interest added later
  amount_paid      BIGINT NOT NULL DEFAULT 0,
  amount_credited  BIGINT NOT NULL DEFAULT 0,  -- settlement discounts + applied deposits
  notes            TEXT,
  source_type      TEXT,                    -- job_card | trip | rental
  source_id        UUID,
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX invoices_org_customer_idx ON invoices (org_id, customer_id);
CREATE INDEX invoices_org_status_idx ON invoices (org_id, status, due_date);

CREATE TABLE invoice_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id         UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  item_id            UUID REFERENCES inventory_items(id),
  description        TEXT NOT NULL,
  quantity           NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  unit_price         BIGINT NOT NULL CHECK (unit_price >= 0),
  gross              BIGINT NOT NULL,
  discount           BIGINT NOT NULL DEFAULT 0,
  vat_rate_bp        INT NOT NULL DEFAULT 0,
  vat                BIGINT NOT NULL DEFAULT 0,
  total              BIGINT NOT NULL,
  revenue_account_id UUID NOT NULL REFERENCES accounts(id),
  cost_ngn           BIGINT NOT NULL DEFAULT 0   -- COGS recognised for this line
);

-- ---------------------------------------------------------------- purchases (accounts payable)

CREATE TABLE bills (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number           TEXT NOT NULL,           -- internal BILL-000001
  supplier_ref     TEXT,                    -- supplier's own invoice number
  supplier_id      UUID NOT NULL REFERENCES contacts(id),
  bill_date        DATE NOT NULL,
  due_date         DATE NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'NGN',
  fx_rate          NUMERIC(18, 6) NOT NULL DEFAULT 1,
  subtotal         BIGINT NOT NULL,         -- in bill currency
  vat_total        BIGINT NOT NULL DEFAULT 0,
  total            BIGINT NOT NULL,         -- in bill currency
  total_ngn        BIGINT NOT NULL,         -- AP carried at the bill-date rate
  amount_paid      BIGINT NOT NULL DEFAULT 0,  -- in bill currency (incl. discounts received)
  ap_relieved_ngn  BIGINT NOT NULL DEFAULT 0,  -- AP carrying value cleared so far (for exact FX gain/loss)
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partially_paid', 'paid', 'void')),
  category         TEXT,
  notes            TEXT,
  attachment_url   TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX bills_org_supplier_idx ON bills (org_id, supplier_id);
CREATE INDEX bills_org_status_idx ON bills (org_id, status, due_date);

CREATE TABLE bill_lines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id     UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  account_id  UUID NOT NULL REFERENCES accounts(id),
  item_id     UUID REFERENCES inventory_items(id),
  quantity    INT,                           -- for part stock purchases
  amount      BIGINT NOT NULL CHECK (amount >= 0),   -- bill currency, excl. VAT
  amount_ngn  BIGINT NOT NULL,
  vat_rate_bp INT NOT NULL DEFAULT 0,
  vat         BIGINT NOT NULL DEFAULT 0,
  capitalize  BOOLEAN NOT NULL DEFAULT false   -- adds to vehicle landed cost
);

-- ---------------------------------------------------------------- operations: workshop / haulage / rentals

CREATE TABLE job_cards (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number        TEXT NOT NULL,
  customer_id   UUID NOT NULL REFERENCES contacts(id),
  item_id       UUID REFERENCES inventory_items(id),  -- when servicing the dealer's own stock
  vehicle_desc  TEXT,
  vin           TEXT,
  plate_number  TEXT,
  odometer_km   INT,
  complaint     TEXT,
  diagnosis     TEXT,
  assigned_to   UUID REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'invoiced', 'cancelled')),
  promised_at   TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  invoice_id    UUID REFERENCES invoices(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE job_card_lines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_card_id UUID NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('labour', 'part')),
  item_id     UUID REFERENCES inventory_items(id),
  description TEXT NOT NULL,
  quantity    NUMERIC(12, 3) NOT NULL DEFAULT 1,
  unit_price  BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE fleet_assets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('truck', 'car_carrier', 'tow_truck', 'trailer', 'van')),
  plate_number TEXT NOT NULL,
  make         TEXT,
  model        TEXT,
  capacity     TEXT,
  status       TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'on_trip', 'maintenance', 'retired')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, plate_number)
);

CREATE TABLE trips (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number         TEXT NOT NULL,
  customer_id    UUID NOT NULL REFERENCES contacts(id),
  asset_id       UUID REFERENCES fleet_assets(id),
  driver_name    TEXT,
  driver_phone   TEXT,
  origin         TEXT NOT NULL,
  destination    TEXT NOT NULL,
  cargo          TEXT,
  units          INT NOT NULL DEFAULT 1,
  pickup_date    DATE,
  delivery_date  DATE,
  rate_ngn       BIGINT NOT NULL CHECK (rate_ngn >= 0),
  status         TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'in_transit', 'delivered', 'invoiced', 'cancelled')),
  waybill_no     TEXT,
  notes          TEXT,
  invoice_id     UUID REFERENCES invoices(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE rental_bookings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number            TEXT NOT NULL,
  customer_id       UUID NOT NULL REFERENCES contacts(id),
  item_id           UUID NOT NULL REFERENCES inventory_items(id),
  start_date        DATE NOT NULL,
  end_date          DATE NOT NULL,
  daily_rate_ngn    BIGINT NOT NULL CHECK (daily_rate_ngn >= 0),
  deposit_ngn       BIGINT NOT NULL DEFAULT 0,
  with_driver       BOOLEAN NOT NULL DEFAULT false,
  status            TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'active', 'returned', 'invoiced', 'cancelled')),
  checkout_mileage  INT,
  checkin_mileage   INT,
  returned_on       DATE,
  late_fee_ngn      BIGINT NOT NULL DEFAULT 0,
  damage_fee_ngn    BIGINT NOT NULL DEFAULT 0,
  invoice_id        UUID REFERENCES invoices(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (end_date >= start_date),
  -- A car cannot be double-booked.
  EXCLUDE USING gist (
    item_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status IN ('reserved', 'active'))
);

-- ---------------------------------------------------------------- expenses

CREATE TABLE expenses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  expense_date      DATE NOT NULL,
  category          TEXT NOT NULL,
  description       TEXT NOT NULL,
  account_id        UUID NOT NULL REFERENCES accounts(id),
  paid_from_account_id UUID NOT NULL REFERENCES accounts(id),
  amount_ngn        BIGINT NOT NULL CHECK (amount_ngn > 0),  -- excl. VAT
  vat_ngn           BIGINT NOT NULL DEFAULT 0,
  item_id           UUID REFERENCES inventory_items(id),
  trip_id           UUID REFERENCES trips(id),
  job_card_id       UUID REFERENCES job_cards(id),
  capitalize        BOOLEAN NOT NULL DEFAULT false,
  supplier_id       UUID REFERENCES contacts(id),
  receipt_url       TEXT,
  journal_entry_id  UUID REFERENCES journal_entries(id),
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX expenses_org_date_idx ON expenses (org_id, expense_date);

-- ---------------------------------------------------------------- payments & installments

CREATE TABLE installment_plans (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id       UUID NOT NULL UNIQUE REFERENCES invoices(id),
  down_payment     BIGINT NOT NULL DEFAULT 0,
  financed_amount  BIGINT NOT NULL,
  interest_rate_bp INT NOT NULL DEFAULT 0,   -- flat rate over the whole plan
  interest_total   BIGINT NOT NULL DEFAULT 0,
  num_installments INT NOT NULL CHECK (num_installments > 0),
  frequency        TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  start_date       DATE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'defaulted', 'cancelled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE installments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     UUID NOT NULL REFERENCES installment_plans(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seq         INT NOT NULL,                 -- 0 = down payment
  due_date    DATE NOT NULL,
  amount_due  BIGINT NOT NULL,
  amount_paid BIGINT NOT NULL DEFAULT 0,
  UNIQUE (plan_id, seq)
);

CREATE TABLE payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number           TEXT NOT NULL,           -- RCT-000001 (in) / PAY-000001 (out)
  direction        TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  contact_id       UUID NOT NULL REFERENCES contacts(id),
  payment_date     DATE NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'NGN',
  fx_rate          NUMERIC(18, 6) NOT NULL DEFAULT 1,
  amount           BIGINT NOT NULL CHECK (amount >= 0),   -- cash moved, in payment currency
  amount_ngn       BIGINT NOT NULL,
  method           TEXT NOT NULL DEFAULT 'transfer' CHECK (method IN ('cash', 'transfer', 'pos', 'cheque', 'card', 'deposit')),
  account_id       UUID REFERENCES accounts(id),           -- cash/bank account (null when applying a deposit)
  reference        TEXT,
  unallocated_ngn  BIGINT NOT NULL DEFAULT 0, -- held as customer deposit / supplier advance
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX payments_org_contact_idx ON payments (org_id, contact_id);

CREATE TABLE payment_allocations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id    UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id    UUID REFERENCES invoices(id),
  bill_id       UUID REFERENCES bills(id),
  amount        BIGINT NOT NULL,       -- settled in the document's currency (incl. discount)
  discount      BIGINT NOT NULL DEFAULT 0,  -- settlement discount, document currency
  fx_gain_loss_ngn BIGINT NOT NULL DEFAULT 0, -- positive = gain
  CHECK ((invoice_id IS NULL) <> (bill_id IS NULL))
);

-- ---------------------------------------------------------------- marketplace link

CREATE TABLE marketplace_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  item_id         UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  action          TEXT NOT NULL CHECK (action IN ('upsert', 'unpublish')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ
);
CREATE INDEX marketplace_outbox_due_idx ON marketplace_outbox (status, next_attempt_at);

CREATE TABLE marketplace_leads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  item_id      UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
  listing_id   TEXT,
  buyer_name   TEXT,
  buyer_phone  TEXT,
  buyer_email  TEXT,
  message      TEXT,
  channel      TEXT NOT NULL DEFAULT 'whatsapp',
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'won', 'lost')),
  contact_id   UUID REFERENCES contacts(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- AI usage metering

CREATE TABLE ai_usage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id),
  feature       TEXT NOT NULL,
  input_tokens  INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_org_month_idx ON ai_usage (org_id, created_at);
