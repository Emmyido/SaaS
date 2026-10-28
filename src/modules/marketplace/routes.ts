import crypto from "node:crypto";
import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { pool, tx, one, many } from "../../db/pool.js";
import { config } from "../../config.js";
import { notFound, unauthorized } from "../../lib/errors.js";
import { ROLES, requireFeature, requireRole } from "../../plugins/context.js";
import { idParams, paging } from "../../lib/schemas.js";
import { processOutbox } from "./worker.js";
import { queueMarketplaceSync } from "./sync.js";

const tags = ["Marketplace"];

/** Authenticated marketplace endpoints (leads, sync status). */
export const marketplaceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/marketplace/status", { schema: { tags, summary: "Listing sync status" } }, async (req) => {
    const counts = await many(pool, `SELECT marketplace_status AS status, count(*)::int AS n FROM inventory_items WHERE org_id = $1 GROUP BY 1`, [req.ctx.orgId]);
    const errors = await many(
      pool,
      `SELECT id, title, marketplace_error FROM inventory_items WHERE org_id = $1 AND marketplace_status = 'error' ORDER BY updated_at DESC LIMIT 20`,
      [req.ctx.orgId],
    );
    return { counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), errors };
  });

  app.post("/marketplace/resync", {
    preValidation: [requireFeature("marketplace"), requireRole(ROLES.admin)],
    schema: { tags, summary: "Re-queue every item for the marketplace and push now" },
  }, async (req) => {
    await tx(async (db) => {
      await db.query(
        `UPDATE marketplace_outbox SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE org_id = $1 AND status = 'failed'`,
        [req.ctx.orgId],
      );
      const items = await many(db, `SELECT id FROM inventory_items WHERE org_id = $1 AND status <> 'archived'`, [req.ctx.orgId]);
      for (const i of items) await queueMarketplaceSync(db, req.ctx.orgId, i.id);
    });
    return { processed: await processOutbox(100) };
  });

  app.get("/leads", { schema: { tags, querystring: paging.extend({ status: z.enum(["new", "contacted", "won", "lost"]).optional() }) } }, async (req) =>
    many(
      pool,
      `SELECT l.*, i.title AS item_title FROM marketplace_leads l LEFT JOIN inventory_items i ON i.id = l.item_id
        WHERE l.org_id = $1 AND ($2::text IS NULL OR l.status = $2) ORDER BY l.created_at DESC LIMIT $3 OFFSET $4`,
      [req.ctx.orgId, req.query.status ?? null, req.query.limit ?? 50, req.query.offset ?? 0],
    ));

  app.patch("/leads/:id", {
    preValidation: requireRole(ROLES.sales),
    schema: { tags, params: idParams, body: z.object({ status: z.enum(["new", "contacted", "won", "lost"]).optional(), createContact: z.boolean().optional() }) },
  }, async (req) =>
    tx(async (db) => {
      const lead = await one(db, `SELECT * FROM marketplace_leads WHERE id = $1 AND org_id = $2 FOR UPDATE`, [req.params.id, req.ctx.orgId]);
      if (!lead) throw notFound("Lead");
      let contactId = lead.contact_id;
      if (req.body.createContact && !contactId) {
        const c = await one(db, `INSERT INTO contacts (org_id, kind, name, phone, email, notes) VALUES ($1,'customer',$2,$3,$4,$5) RETURNING id`, [
          req.ctx.orgId, lead.buyer_name ?? lead.buyer_phone ?? "Marketplace buyer", lead.buyer_phone, lead.buyer_email, "From greenrevs.com enquiry",
        ]);
        contactId = c.id;
      }
      return one(db, `UPDATE marketplace_leads SET status = COALESCE($2, status), contact_id = $3 WHERE id = $1 RETURNING *`, [
        lead.id, req.body.status ?? null, contactId,
      ]);
    }));
};

export function verifySignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = signature.replace(/^sha256=/, "");
  return expected.length === given.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

const webhookBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("lead.created"),
    data: z.object({
      listingId: z.string(), externalId: z.string().optional(), buyerName: z.string().optional(), buyerPhone: z.string().optional(),
      buyerEmail: z.string().optional(), message: z.string().optional(), channel: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("listing.removed"),
    data: z.object({ listingId: z.string(), reason: z.string().optional() }),
  }),
]);

/** Public webhook the GreenRev marketplace calls (HMAC-SHA256 signed with GREENREV_WEBHOOK_SECRET). */
export const marketplaceWebhookRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post("/webhooks/greenrev", { schema: { tags, summary: "Inbound events from greenrevs.com", body: webhookBody } }, async (req) => {
    if (!verifySignature(req.rawBody ?? "", req.headers["x-greenrev-signature"] as string | undefined, config.greenrev.webhookSecret)) {
      throw unauthorized("Bad webhook signature");
    }
    const event = req.body;
    const item = await one(
      pool,
      `SELECT id, org_id FROM inventory_items WHERE marketplace_listing_id = $1 OR id::text = $2 LIMIT 1`,
      [event.data.listingId, "externalId" in event.data ? event.data.externalId ?? "" : ""],
    );
    if (!item) return { ok: true, matched: false };
    if (event.type === "lead.created") {
      const d = event.data;
      await pool.query(
        `INSERT INTO marketplace_leads (org_id, item_id, listing_id, buyer_name, buyer_phone, buyer_email, message, channel) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [item.org_id, item.id, d.listingId, d.buyerName ?? null, d.buyerPhone ?? null, d.buyerEmail ?? null, d.message ?? null, d.channel ?? "whatsapp"],
      );
    } else {
      // Marketplace moderation took it down: stop auto-republishing until the dealer acts.
      await pool.query(
        `UPDATE inventory_items SET publish_to_marketplace = false, marketplace_status = 'unlisted', marketplace_listing_id = NULL, marketplace_error = $2 WHERE id = $1`,
        [item.id, `Removed by marketplace${event.data.reason ? `: ${event.data.reason}` : ""}`],
      );
    }
    return { ok: true, matched: true };
  });
};
