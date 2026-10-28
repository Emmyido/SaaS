import { pool, one, many, tx } from "../../db/pool.js";
import { getMarketplaceAdapter, type MarketplaceListing } from "./adapter.js";
import { shouldBeListed } from "./sync.js";

const MAX_ATTEMPTS = 8;

export async function buildListing(itemId: string): Promise<MarketplaceListing | null> {
  const i = await one(
    pool,
    `SELECT i.*, o.name AS org_name, o.phone AS org_phone, o.whatsapp AS org_whatsapp, o.city, o.state, o.logo_url, o.greenrev_seller_id
       FROM inventory_items i JOIN organizations o ON o.id = i.org_id WHERE i.id = $1`,
    [itemId],
  );
  if (!i) return null;
  const photos = await many(pool, `SELECT url FROM item_photos WHERE item_id = $1 ORDER BY position, created_at`, [itemId]);
  return {
    externalId: i.id,
    sellerId: i.greenrev_seller_id,
    seller: { name: i.org_name, phone: i.org_phone, whatsapp: i.org_whatsapp ?? i.org_phone, city: i.city, state: i.state, logoUrl: i.logo_url },
    type: i.kind,
    title: i.title,
    description: i.description,
    priceNgn: i.kind === "vehicle" ? i.asking_price_ngn : i.unit_price_ngn,
    currency: "NGN",
    status: i.status === "in_transit" ? "in_transit" : i.status === "reserved" ? "reserved" : "available",
    photos: photos.map((p) => p.url),
    vehicle: i.kind === "vehicle" ? {
      make: i.make, model: i.model, year: i.year, trim: i.trim, bodyType: i.body_type, color: i.color, mileageKm: i.mileage_km,
      fuelType: i.fuel_type, transmission: i.transmission, engine: i.engine, condition: i.condition, vinLast6: i.vin ? i.vin.slice(-6) : null,
    } : undefined,
    part: i.kind !== "vehicle" ? {
      partNumber: i.part_number, brand: i.brand, compatibleWith: i.compatible_with, condition: i.condition, quantityAvailable: i.quantity,
    } : undefined,
    attributes: i.attributes,
    updatedAt: new Date(i.updated_at).toISOString(),
  };
}

/** Process due outbox jobs. Safe to run from several workers at once (SKIP LOCKED). */
export async function processOutbox(batchSize = 20): Promise<number> {
  let processed = 0;
  for (let n = 0; n < batchSize; n++) {
    const done = await tx(async (db) => {
      const job = await one(
        db,
        `SELECT * FROM marketplace_outbox WHERE status = 'pending' AND next_attempt_at <= now()
          ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!job) return false;
      const item = await one(db, `SELECT * FROM inventory_items WHERE id = $1 FOR UPDATE`, [job.item_id]);
      const adapter = getMarketplaceAdapter();
      try {
        // Re-evaluate against current state: the job may be stale.
        const listNow = item && shouldBeListed(item);
        if (listNow) {
          const listing = await buildListing(job.item_id);
          const res = await adapter.upsert(listing!, item.marketplace_listing_id);
          await db.query(
            `UPDATE inventory_items SET marketplace_status = 'listed', marketplace_listing_id = $2, marketplace_synced_at = now(), marketplace_error = NULL WHERE id = $1`,
            [job.item_id, res.listingId],
          );
        } else if (item) {
          if (item.marketplace_listing_id) await adapter.unpublish(item.marketplace_listing_id);
          await db.query(
            `UPDATE inventory_items SET marketplace_status = 'unlisted', marketplace_listing_id = NULL, marketplace_synced_at = now(), marketplace_error = NULL WHERE id = $1`,
            [job.item_id],
          );
        }
        await db.query(`UPDATE marketplace_outbox SET status = 'done', attempts = attempts + 1, processed_at = now() WHERE id = $1`, [job.id]);
      } catch (err) {
        const attempts = job.attempts + 1;
        const failed = attempts >= MAX_ATTEMPTS;
        const message = (err as Error).message.slice(0, 1000);
        await db.query(
          `UPDATE marketplace_outbox SET attempts = $2, status = $3, last_error = $4,
                  next_attempt_at = now() + make_interval(secs => $5) WHERE id = $1`,
          [job.id, attempts, failed ? "failed" : "pending", message, Math.min(3600, 2 ** attempts * 15)],
        );
        if (item) await db.query(`UPDATE inventory_items SET marketplace_status = $2, marketplace_error = $3 WHERE id = $1`, [job.item_id, failed ? "error" : "pending", message]);
      }
      return true;
    });
    if (!done) break;
    processed++;
  }
  return processed;
}

export function startOutboxLoop(intervalMs = 5000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processOutbox();
    } catch (err) {
      console.error("marketplace outbox error", err);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
