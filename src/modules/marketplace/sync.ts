import type { Db } from "../../db/pool.js";
import { one } from "../../db/pool.js";

/**
 * Decide whether an item should be live on the GreenRev marketplace and queue the change.
 * Called after every inventory mutation inside the same transaction, so the outbox row
 * commits (or rolls back) together with the business change.
 */
export async function queueMarketplaceSync(db: Db, orgId: string, itemId: string): Promise<void> {
  const item = await one(
    db,
    `SELECT i.kind, i.status, i.publish_to_marketplace, i.asking_price_ngn, i.unit_price_ngn, i.quantity,
            i.marketplace_status, i.marketplace_listing_id
       FROM inventory_items i WHERE i.id = $1 AND i.org_id = $2`,
    [itemId, orgId],
  );
  if (!item) return;

  const live = item.marketplace_status === "listed" || item.marketplace_status === "pending" || item.marketplace_listing_id;
  const action = shouldBeListed(item) ? "upsert" : live ? "unpublish" : null;
  if (!action) return;

  // Collapse to a single pending job per item; the worker always sends the item's latest state.
  const existing = await one(
    db,
    `SELECT id FROM marketplace_outbox WHERE item_id = $1 AND status = 'pending' FOR UPDATE`,
    [itemId],
  );
  if (existing) {
    await db.query(`UPDATE marketplace_outbox SET action = $2, next_attempt_at = now() WHERE id = $1`, [existing.id, action]);
  } else {
    await db.query(`INSERT INTO marketplace_outbox (org_id, item_id, action) VALUES ($1, $2, $3)`, [orgId, itemId, action]);
  }
  await db.query(
    `UPDATE inventory_items SET marketplace_status = 'pending', marketplace_error = NULL WHERE id = $1`,
    [itemId],
  );
}

export function shouldBeListed(item: {
  kind: string;
  status: string;
  publish_to_marketplace: boolean;
  asking_price_ngn: number | null;
  unit_price_ngn: number | null;
  quantity: number;
}): boolean {
  if (!item.publish_to_marketplace) return false;
  if (item.kind === "vehicle") {
    return ["in_stock", "in_transit", "reserved"].includes(item.status) && (item.asking_price_ngn ?? 0) > 0;
  }
  return item.status === "in_stock" && item.quantity > 0 && (item.unit_price_ngn ?? 0) > 0;
}
