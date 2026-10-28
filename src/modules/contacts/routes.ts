import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { pool, one, many } from "../../db/pool.js";
import { notFound } from "../../lib/errors.js";
import { ROLES, requireRole } from "../../plugins/context.js";
import { idParams, isoDate, paging } from "../../lib/schemas.js";
import { today } from "../../lib/dates.js";
import { contactStatement } from "../accounting/reports.js";
import { depositBalance } from "../accounting/payments.js";

const tags = ["Contacts"];
const body = z.object({
  kind: z.enum(["customer", "supplier", "both"]),
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  tin: z.string().optional(),
  country: z.string().optional(),
  notes: z.string().optional(),
});

export const contactRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/contacts", {
    schema: { tags, querystring: paging.extend({ kind: z.enum(["customer", "supplier"]).optional(), q: z.string().optional() }) },
  }, async (req) => {
    const { kind, q, limit = 50, offset = 0 } = req.query;
    return many(
      pool,
      `SELECT c.*,
              (SELECT COALESCE(SUM(i.total + i.finance_charges - i.amount_paid - i.amount_credited), 0) FROM invoices i
                WHERE i.customer_id = c.id AND i.status IN ('issued', 'partially_paid'))::bigint AS receivable,
              (SELECT COALESCE(SUM(b.total_ngn - b.ap_relieved_ngn), 0) FROM bills b
                WHERE b.supplier_id = c.id AND b.status IN ('open', 'partially_paid'))::bigint AS payable
         FROM contacts c
        WHERE c.org_id = $1 AND ($2::text IS NULL OR c.kind = $2 OR c.kind = 'both')
          AND ($3::text IS NULL OR c.name ILIKE '%' || $3 || '%' OR c.phone ILIKE '%' || $3 || '%')
        ORDER BY c.name LIMIT $4 OFFSET $5`,
      [req.ctx.orgId, kind ?? null, q ?? null, limit, offset],
    );
  });

  app.post("/contacts", { preValidation: requireRole(ROLES.write), schema: { tags, body } }, async (req, reply) => {
    const b = req.body;
    reply.code(201);
    return one(
      pool,
      `INSERT INTO contacts (org_id, kind, name, phone, email, address, tin, country, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.ctx.orgId, b.kind, b.name, b.phone ?? null, b.email ?? null, b.address ?? null, b.tin ?? null, b.country ?? null, b.notes ?? null],
    );
  });

  app.get("/contacts/:id", { schema: { tags, params: idParams } }, async (req) => {
    const c = await one(pool, `SELECT * FROM contacts WHERE id = $1 AND org_id = $2`, [req.params.id, req.ctx.orgId]);
    if (!c) throw notFound("Contact");
    c.deposit_balance = await depositBalance(pool, req.ctx.orgId, c.id);
    return c;
  });

  app.patch("/contacts/:id", { preValidation: requireRole(ROLES.write), schema: { tags, params: idParams, body: body.partial() } }, async (req) => {
    const b = req.body;
    const c = await one(
      pool,
      `UPDATE contacts SET kind = COALESCE($3, kind), name = COALESCE($4, name), phone = COALESCE($5, phone), email = COALESCE($6, email),
              address = COALESCE($7, address), tin = COALESCE($8, tin), country = COALESCE($9, country), notes = COALESCE($10, notes)
        WHERE id = $1 AND org_id = $2 RETURNING *`,
      [req.params.id, req.ctx.orgId, b.kind ?? null, b.name ?? null, b.phone ?? null, b.email ?? null, b.address ?? null, b.tin ?? null, b.country ?? null, b.notes ?? null],
    );
    if (!c) throw notFound("Contact");
    return c;
  });

  app.get("/contacts/:id/statement", {
    schema: { tags, summary: "Customer/supplier statement of account", params: idParams, querystring: z.object({ from: isoDate.default("2000-01-01"), to: isoDate.optional() }) },
  }, async (req) => contactStatement(pool, req.ctx.orgId, req.params.id, req.query.from, req.query.to ?? today()));
};
