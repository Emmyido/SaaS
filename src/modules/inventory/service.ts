import type { Db } from "../../db/pool.js";
import { one, many } from "../../db/pool.js";
import { badRequest, conflict, notFound, paymentRequired } from "../../lib/errors.js";
import { today } from "../../lib/dates.js";
import { normaliseVin } from "../../lib/vin.js";
import { getPlan } from "../billing/plans.js";
import type { OrgContext } from "../../plugins/context.js";
import { accountId } from "../accounting/chart.js";
import { postEntry } from "../accounting/ledger.js";
import { createBill } from "../accounting/bills.js";
import { queueMarketplaceSync } from "../marketplace/sync.js";
import { adjustLandedCost, getItemForUpdate, inventoryAccountKey, issueStock, receiveStock } from "./stock.js";

export interface VehicleInput {
  title?: string;
  vin?: string;
  make: string;
  model: string;
  year?: number;
  trim?: string;
  bodyType?: string;
  color?: string;
  mileageKm?: number;
  fuelType?: string;
  transmission?: string;
  engine?: string;
  condition?: "brand_new" | "foreign_used" | "nigerian_used";
  plateNumber?: string;
  status?: "draft" | "in_transit" | "in_stock" | "in_repair";
  branch?: string;
  description?: string;
  askingPriceNgn?: number;
  minPriceNgn?: number;
  isRentable?: boolean;
  dailyRateNgn?: number;
  publishToMarketplace?: boolean;
  attributes?: Record<string, unknown>;
  purchasedAt?: string;
  /** Record what the car cost: creates a supplier bill (foreign currency supported) and capitalises it. */
  purchase?: {
    supplierId: string;
    currency?: string;
    amount: number;        // in purchase currency, minor units
    fxRate?: number;       // NGN per unit; defaults to the saved rate for the day
    importDutyNgn?: number;
    clearingNgn?: number;
    shippingNgn?: number;
    supplierRef?: string;
    dueDate?: string;
    paidFromAccountId?: string; // pay immediately (cash purchase)
  };
  /** For cars already owned when onboarding: cost posted against opening balance equity. */
  openingCostNgn?: number;
}

export interface PartInput {
  kind?: "part" | "accessory";
  title: string;
  sku?: string;
  partNumber?: string;
  brand?: string;
  compatibleWith?: string[];
  condition?: "brand_new" | "foreign_used" | "nigerian_used";
  unitPriceNgn?: number;
  reorderLevel?: number;
  branch?: string;
  description?: string;
  publishToMarketplace?: boolean;
  attributes?: Record<string, unknown>;
  openingQuantity?: number;
  openingUnitCostNgn?: number;
}

async function assertWithinLimit(db: Db, ctx: OrgContext, kind: "vehicle" | "part") {
  const plan = getPlan(ctx.plan);
  const limit = kind === "vehicle" ? plan.limits.vehicles : plan.limits.parts;
  if (limit === null) return;
  const r = await one(
    db,
    kind === "vehicle"
      ? `SELECT count(*)::int AS n FROM inventory_items WHERE org_id = $1 AND kind = 'vehicle' AND status NOT IN ('sold', 'archived')`
      : `SELECT count(*)::int AS n FROM inventory_items WHERE org_id = $1 AND kind <> 'vehicle' AND status <> 'archived'`,
    [ctx.orgId],
  );
  if (r.n >= limit) {
    throw paymentRequired(`Your ${plan.name} package allows ${limit} active ${kind === "vehicle" ? "vehicles" : "parts"}. Upgrade to Pro for unlimited stock.`, {
      limit,
      upgradeTo: "pro",
    });
  }
}

async function orgAutoPublish(db: Db, orgId: string): Promise<boolean> {
  const r = await one(db, `SELECT auto_publish FROM organizations WHERE id = $1`, [orgId]);
  return r?.auto_publish ?? true;
}

export async function createVehicle(db: Db, ctx: OrgContext, input: VehicleInput) {
  await assertWithinLimit(db, ctx, "vehicle");
  const vin = input.vin ? normaliseVin(input.vin) : null;
  if (vin && (await one(db, `SELECT 1 FROM inventory_items WHERE org_id = $1 AND vin = $2 AND status <> 'archived'`, [ctx.orgId, vin]))) {
    throw conflict(`A vehicle with VIN ${vin} is already in your inventory`);
  }
  const title = input.title ?? [input.year, input.make, input.model, input.trim].filter(Boolean).join(" ");
  const publish = input.publishToMarketplace ?? (input.isRentable ? false : await orgAutoPublish(db, ctx.orgId));
  const item = await one(
    db,
    `INSERT INTO inventory_items (org_id, kind, status, title, vin, make, model, year, trim, body_type, color, mileage_km, fuel_type, transmission,
                                  engine, condition, plate_number, branch, description, asking_price_ngn, min_price_ngn, is_rentable, daily_rate_ngn,
                                  publish_to_marketplace, attributes, purchased_at, purchase_currency, purchase_amount, supplier_id)
     VALUES ($1,'vehicle',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING *`,
    [ctx.orgId, input.status ?? "in_stock", title, vin, input.make, input.model, input.year ?? null, input.trim ?? null, input.bodyType ?? null,
      input.color ?? null, input.mileageKm ?? null, input.fuelType ?? null, input.transmission ?? null, input.engine ?? null, input.condition ?? null,
      input.plateNumber ?? null, input.branch ?? null, input.description ?? null, input.askingPriceNgn ?? null, input.minPriceNgn ?? null,
      input.isRentable ?? false, input.dailyRateNgn ?? null, publish, input.attributes ?? {}, input.purchasedAt ?? (input.purchase || input.openingCostNgn ? today() : null),
      input.purchase?.currency ?? (input.purchase ? "NGN" : null), input.purchase?.amount ?? null, input.purchase?.supplierId ?? null],
  );

  if (input.openingCostNgn) {
    await db.query(`UPDATE inventory_items SET landed_cost_ngn = $2 WHERE id = $1`, [item.id, input.openingCostNgn]);
    await postEntry(db, ctx.orgId, {
      date: input.purchasedAt ?? today(),
      memo: `Opening stock: ${title}`,
      sourceType: "opening_stock",
      sourceId: item.id,
      createdBy: ctx.userId,
      lines: [
        { accountId: await accountId(db, ctx.orgId, inventoryAccountKey(item)), debit: input.openingCostNgn, itemId: item.id },
        { accountId: await accountId(db, ctx.orgId, "opening_balance"), credit: input.openingCostNgn },
      ],
    });
  }

  if (input.purchase) {
    const p = input.purchase;
    const date = input.purchasedAt ?? today();
    const currency = p.currency ?? "NGN";
    // Car cost (possibly foreign) on one bill; naira-denominated landing costs on a second, NGN bill if present.
    const bill = await createBill(db, ctx, {
      supplierId: p.supplierId,
      supplierRef: p.supplierRef,
      billDate: date,
      dueDate: p.dueDate,
      currency,
      fxRate: p.fxRate,
      category: "vehicle_purchase",
      lines: [{ description: `Purchase of ${title}${vin ? ` (VIN ${vin})` : ""}`, amount: p.amount, itemId: item.id, capitalize: true }],
      paidFromAccountId: p.paidFromAccountId,
    });
    await db.query(`UPDATE inventory_items SET purchase_fx_rate = $2 WHERE id = $1`, [item.id, bill.fx_rate]);
    const landing = [
      { description: "Import duty", amount: p.importDutyNgn },
      { description: "Clearing & port charges", amount: p.clearingNgn },
      { description: "Shipping / transport", amount: p.shippingNgn },
    ].filter((l) => l.amount && l.amount > 0) as Array<{ description: string; amount: number }>;
    if (landing.length) {
      await createBill(db, ctx, {
        supplierId: p.supplierId,
        billDate: date,
        dueDate: p.dueDate,
        currency: "NGN",
        category: "clearing",
        lines: landing.map((l) => ({ description: `${l.description}: ${title}`, amount: l.amount, itemId: item.id, capitalize: true })),
        paidFromAccountId: p.paidFromAccountId,
      });
    }
  }
  await queueMarketplaceSync(db, ctx.orgId, item.id);
  return getItem(db, ctx.orgId, item.id);
}

export async function createPart(db: Db, ctx: OrgContext, input: PartInput) {
  await assertWithinLimit(db, ctx, "part");
  if (input.sku && (await one(db, `SELECT 1 FROM inventory_items WHERE org_id = $1 AND sku = $2`, [ctx.orgId, input.sku]))) {
    throw conflict(`SKU ${input.sku} already exists`);
  }
  const publish = input.publishToMarketplace ?? (await orgAutoPublish(db, ctx.orgId));
  const item = await one(
    db,
    `INSERT INTO inventory_items (org_id, kind, status, title, sku, part_number, brand, compatible_with, condition, unit_price_ngn, reorder_level, branch,
                                  description, publish_to_marketplace, attributes)
     VALUES ($1,$2,'in_stock',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [ctx.orgId, input.kind ?? "part", input.title, input.sku ?? null, input.partNumber ?? null, input.brand ?? null, input.compatibleWith ?? [],
      input.condition ?? null, input.unitPriceNgn ?? null, input.reorderLevel ?? 0, input.branch ?? null, input.description ?? null, publish,
      input.attributes ?? {}],
  );
  if (input.openingQuantity && input.openingQuantity > 0) {
    const cost = (input.openingUnitCostNgn ?? 0) * input.openingQuantity;
    await receiveStock(db, ctx.orgId, item.id, input.openingQuantity, cost, "adjustment", { type: "opening_stock", id: item.id });
    if (cost > 0) {
      await postEntry(db, ctx.orgId, {
        date: today(),
        memo: `Opening stock: ${input.title}`,
        sourceType: "opening_stock",
        sourceId: item.id,
        createdBy: ctx.userId,
        lines: [
          { accountId: await accountId(db, ctx.orgId, "inventory_parts"), debit: cost, itemId: item.id },
          { accountId: await accountId(db, ctx.orgId, "opening_balance"), credit: cost },
        ],
      });
    }
  }
  await queueMarketplaceSync(db, ctx.orgId, item.id);
  return getItem(db, ctx.orgId, item.id);
}

const UPDATABLE: Record<string, string> = {
  title: "title", make: "make", model: "model", year: "year", trim: "trim", bodyType: "body_type", color: "color", mileageKm: "mileage_km",
  fuelType: "fuel_type", transmission: "transmission", engine: "engine", condition: "condition", plateNumber: "plate_number", branch: "branch",
  description: "description", askingPriceNgn: "asking_price_ngn", minPriceNgn: "min_price_ngn", isRentable: "is_rentable",
  dailyRateNgn: "daily_rate_ngn", publishToMarketplace: "publish_to_marketplace", attributes: "attributes", sku: "sku", partNumber: "part_number",
  brand: "brand", compatibleWith: "compatible_with", unitPriceNgn: "unit_price_ngn", reorderLevel: "reorder_level", status: "status", vin: "vin",
};

const MANUAL_STATUSES = ["draft", "in_transit", "in_stock", "reserved", "in_repair", "archived"];

export async function updateItem(db: Db, ctx: OrgContext, id: string, patch: Record<string, unknown>) {
  const item = await getItemForUpdate(db, ctx.orgId, id);
  if (patch.status !== undefined) {
    if (!MANUAL_STATUSES.includes(patch.status as string)) throw badRequest(`Status can only be set to ${MANUAL_STATUSES.join(", ")}`);
    if (["sold", "rented"].includes(item.status)) throw conflict(`This item is ${item.status}; that status is managed by its invoice or rental`);
  }
  if (patch.isRentable !== undefined && patch.isRentable !== item.is_rentable && item.landed_cost_ngn > 0) {
    throw conflict("Cannot move a costed vehicle between stock and rental fleet; this changes its asset account");
  }
  if (typeof patch.vin === "string") patch.vin = normaliseVin(patch.vin);
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = UPDATABLE[k];
    if (!col || v === undefined) continue;
    values.push(v);
    sets.push(`${col} = $${values.length + 2}`);
  }
  if (sets.length) {
    await db.query(`UPDATE inventory_items SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND org_id = $2`, [id, ctx.orgId, ...values]);
  }
  await queueMarketplaceSync(db, ctx.orgId, id);
  return getItem(db, ctx.orgId, id);
}

/** Stock count correction for parts: write-off or found stock, posted to Stock Adjustments. */
export async function adjustStock(db: Db, ctx: OrgContext, id: string, input: { quantity: number; unitCostNgn?: number; note?: string; date?: string }) {
  const item = await getItemForUpdate(db, ctx.orgId, id);
  if (item.kind === "vehicle") throw badRequest("Use the vehicle status instead of stock adjustments");
  if (input.quantity === 0) throw badRequest("Quantity must not be zero");
  const date = input.date ?? today();
  let value: number;
  if (input.quantity > 0) {
    value = (input.unitCostNgn ?? item.unit_cost_ngn) * input.quantity;
    await receiveStock(db, ctx.orgId, id, input.quantity, value, "adjustment");
  } else {
    value = -(await issueStock(db, ctx.orgId, id, -input.quantity, "adjustment"));
  }
  if (input.note) {
    await db.query(`UPDATE stock_movements SET note = $2 WHERE id = (SELECT id FROM stock_movements WHERE item_id = $1 ORDER BY created_at DESC LIMIT 1)`, [id, input.note]);
  }
  if (value !== 0) {
    await postEntry(db, ctx.orgId, {
      date,
      memo: `Stock adjustment: ${item.title}${input.note ? ` (${input.note})` : ""}`,
      sourceType: "stock_adjustment",
      sourceId: id,
      createdBy: ctx.userId,
      lines: [
        { accountId: await accountId(db, ctx.orgId, "inventory_parts"), debit: value, itemId: id },
        { accountId: await accountId(db, ctx.orgId, "stock_adjustments"), credit: value, itemId: id },
      ],
    });
  }
  await queueMarketplaceSync(db, ctx.orgId, id);
  return getItem(db, ctx.orgId, id);
}

export async function getItem(db: Db, orgId: string, id: string) {
  const item = await one(db, `SELECT * FROM inventory_items WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!item) throw notFound("Inventory item");
  item.photos = await many(db, `SELECT id, url, position, ai_tags FROM item_photos WHERE item_id = $1 ORDER BY position, created_at`, [id]);
  if (item.kind === "vehicle") {
    item.costs = await many(
      db,
      `SELECT 'bill' AS source, b.id AS source_id, b.number AS reference, b.bill_date AS date, l.description, l.amount_ngn, b.currency, l.amount AS amount_foreign
         FROM bill_lines l JOIN bills b ON b.id = l.bill_id WHERE l.item_id = $1 AND l.capitalize AND b.status <> 'void'
       UNION ALL
       SELECT 'expense', e.id, e.category, e.expense_date, e.description, e.amount_ngn, 'NGN', e.amount_ngn
         FROM expenses e WHERE e.item_id = $1 AND e.capitalize
       ORDER BY date`,
      [id],
    );
    item.margin_at_asking = item.asking_price_ngn ? item.asking_price_ngn - item.landed_cost_ngn : null;
  } else {
    item.stock_value_ngn = item.quantity * item.unit_cost_ngn;
    item.needs_reorder = item.quantity <= item.reorder_level;
  }
  return item;
}

export interface ListFilter {
  kind?: string;
  status?: string;
  make?: string;
  q?: string;
  rentable?: boolean;
  lowStock?: boolean;
  limit?: number;
  offset?: number;
}

export async function listItems(db: Db, orgId: string, f: ListFilter) {
  const where = ["i.org_id = $1"];
  const params: unknown[] = [orgId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (f.kind) add("i.kind = ?", f.kind);
  if (f.status) add("i.status = ANY(string_to_array(?, ','))", f.status);
  else where.push("i.status <> 'archived'");
  if (f.make) add("lower(i.make) = lower(?)", f.make);
  if (f.rentable !== undefined) add("i.is_rentable = ?", f.rentable);
  if (f.lowStock) where.push("i.kind <> 'vehicle' AND i.quantity <= i.reorder_level");
  if (f.q) {
    params.push(`%${f.q}%`);
    const p = `$${params.length}`;
    where.push(`(i.title ILIKE ${p} OR i.vin ILIKE ${p} OR i.sku ILIKE ${p} OR i.part_number ILIKE ${p} OR i.plate_number ILIKE ${p})`);
  }
  params.push(Math.min(f.limit ?? 50, 200), f.offset ?? 0);
  const rows = await many(
    db,
    `SELECT i.*, (SELECT url FROM item_photos p WHERE p.item_id = i.id ORDER BY position, created_at LIMIT 1) AS cover_photo,
            count(*) OVER() AS total_count
       FROM inventory_items i WHERE ${where.join(" AND ")}
      ORDER BY i.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { total: rows[0]?.total_count ?? 0, items: rows.map(({ total_count, ...r }) => r) };
}

export async function addPhoto(db: Db, ctx: OrgContext, itemId: string, url: string, aiTags?: unknown) {
  await getItemForUpdate(db, ctx.orgId, itemId);
  const pos = await one(db, `SELECT COALESCE(MAX(position) + 1, 0) AS p FROM item_photos WHERE item_id = $1`, [itemId]);
  const photo = await one(
    db,
    `INSERT INTO item_photos (org_id, item_id, url, position, ai_tags) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [ctx.orgId, itemId, url, pos.p, aiTags ? JSON.stringify(aiTags) : null],
  );
  await queueMarketplaceSync(db, ctx.orgId, itemId);
  return photo;
}

export async function deletePhoto(db: Db, ctx: OrgContext, itemId: string, photoId: string) {
  const r = await db.query(`DELETE FROM item_photos WHERE id = $1 AND item_id = $2 AND org_id = $3`, [photoId, itemId, ctx.orgId]);
  if (!r.rowCount) throw notFound("Photo");
  await queueMarketplaceSync(db, ctx.orgId, itemId);
}

export async function stockMovements(db: Db, orgId: string, itemId: string) {
  return many(db, `SELECT * FROM stock_movements WHERE org_id = $1 AND item_id = $2 ORDER BY created_at DESC`, [orgId, itemId]);
}

export { adjustLandedCost };
