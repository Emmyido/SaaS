import type { Db } from "../../db/pool.js";
import { one } from "../../db/pool.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { roundMinor } from "../../lib/money.js";

export interface ItemRow {
  id: string;
  org_id: string;
  kind: "vehicle" | "part" | "accessory";
  status: string;
  title: string;
  quantity: number;
  unit_cost_ngn: number;
  landed_cost_ngn: number;
  is_rentable: boolean;
  [key: string]: any;
}

export async function getItemForUpdate(db: Db, orgId: string, itemId: string): Promise<ItemRow> {
  const item = await one<ItemRow>(db, `SELECT * FROM inventory_items WHERE id = $1 AND org_id = $2 FOR UPDATE`, [itemId, orgId]);
  if (!item) throw notFound("Inventory item");
  return item;
}

/** Vehicles held for sale are stock; rental fleet cars are fixed assets. */
export function vehicleAssetKey(item: Pick<ItemRow, "is_rentable">): string {
  return item.is_rentable ? "fixed_assets" : "inventory_vehicles";
}

export function inventoryAccountKey(item: Pick<ItemRow, "kind" | "is_rentable">): string {
  return item.kind === "vehicle" ? vehicleAssetKey(item) : "inventory_parts";
}

/** Receive quantity into stock at a unit cost, updating the weighted-average cost. */
export async function receiveStock(
  db: Db,
  orgId: string,
  itemId: string,
  qty: number,
  totalCostNgn: number,
  reason: "purchase" | "adjustment" | "return" | "void",
  source?: { type: string; id: string },
): Promise<void> {
  if (qty <= 0) throw badRequest("Quantity received must be positive");
  const item = await getItemForUpdate(db, orgId, itemId);
  if (item.kind === "vehicle") throw badRequest("Vehicles are tracked individually, not by quantity");
  const newQty = item.quantity + qty;
  const avg = roundMinor((item.quantity * item.unit_cost_ngn + totalCostNgn) / newQty);
  await db.query(
    `UPDATE inventory_items SET quantity = $2, unit_cost_ngn = $3,
            status = CASE WHEN status IN ('sold', 'draft') THEN 'in_stock' ELSE status END, updated_at = now()
      WHERE id = $1`,
    [itemId, newQty, avg],
  );
  await db.query(
    `INSERT INTO stock_movements (org_id, item_id, quantity, unit_cost_ngn, reason, source_type, source_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [orgId, itemId, qty, roundMinor(totalCostNgn / qty), reason, source?.type ?? null, source?.id ?? null],
  );
}

/** Take quantity out of stock. Returns the cost of goods issued at weighted-average cost. */
export async function issueStock(
  db: Db,
  orgId: string,
  itemId: string,
  qty: number,
  reason: "sale" | "job_card" | "adjustment",
  source?: { type: string; id: string },
): Promise<number> {
  if (qty <= 0 || !Number.isInteger(qty)) throw badRequest("Quantity issued must be a positive whole number");
  const item = await getItemForUpdate(db, orgId, itemId);
  if (item.kind === "vehicle") throw badRequest("Vehicles are tracked individually, not by quantity");
  if (item.quantity < qty) {
    throw badRequest(`Only ${item.quantity} of "${item.title}" in stock (requested ${qty})`);
  }
  const cost = item.unit_cost_ngn * qty;
  const left = item.quantity - qty;
  await db.query(
    `UPDATE inventory_items SET quantity = $2, status = CASE WHEN $2 = 0 THEN 'sold' ELSE status END, updated_at = now() WHERE id = $1`,
    [itemId, left],
  );
  await db.query(
    `INSERT INTO stock_movements (org_id, item_id, quantity, unit_cost_ngn, reason, source_type, source_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [orgId, itemId, -qty, item.unit_cost_ngn, reason, source?.type ?? null, source?.id ?? null],
  );
  return cost;
}

/** Add (or remove, with a negative amount) capitalised cost on a vehicle. */
export async function adjustLandedCost(db: Db, orgId: string, itemId: string, deltaNgn: number): Promise<ItemRow> {
  const item = await getItemForUpdate(db, orgId, itemId);
  if (item.kind !== "vehicle") throw badRequest("Only vehicles carry a landed cost");
  if (deltaNgn > 0 && item.status === "sold") {
    throw badRequest("This vehicle is already sold; record the cost as a normal expense instead of capitalising it");
  }
  await db.query(`UPDATE inventory_items SET landed_cost_ngn = landed_cost_ngn + $2, updated_at = now() WHERE id = $1`, [
    itemId,
    deltaNgn,
  ]);
  return item;
}
