import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { pool, tx, one, many } from "../../db/pool.js";
import { ROLES, requireRole, requireVertical } from "../../plugins/context.js";
import { idParams, isoDate, kobo, paging, rateBp, uuid } from "../../lib/schemas.js";
import { today } from "../../lib/dates.js";
import { createTrip, fleetProfitability, getTrip, invoiceTrip, setTripStatus } from "./service.js";

const tags = ["Haulage"];

export const haulageRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preValidation", requireVertical("haulage"));

  app.get("/fleet", { schema: { tags } }, async (req) => many(pool, `SELECT * FROM fleet_assets WHERE org_id = $1 ORDER BY plate_number`, [req.ctx.orgId]));

  app.post("/fleet", {
    preValidation: requireRole(ROLES.dispatch),
    schema: {
      tags,
      body: z.object({
        kind: z.enum(["truck", "car_carrier", "tow_truck", "trailer", "van"]), plateNumber: z.string(), make: z.string().optional(),
        model: z.string().optional(), capacity: z.string().optional().describe("e.g. '8 cars' or '30 tonnes'"),
      }),
    },
  }, async (req, reply) => {
    reply.code(201);
    const b = req.body;
    return one(pool, `INSERT INTO fleet_assets (org_id, kind, plate_number, make, model, capacity) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
      req.ctx.orgId, b.kind, b.plateNumber, b.make ?? null, b.model ?? null, b.capacity ?? null,
    ]);
  });

  app.get("/trips", { schema: { tags, querystring: paging.extend({ status: z.string().optional() }) } }, async (req) =>
    many(
      pool,
      `SELECT t.*, c.name AS customer_name, a.plate_number AS truck_plate FROM trips t JOIN contacts c ON c.id = t.customer_id
         LEFT JOIN fleet_assets a ON a.id = t.asset_id
        WHERE t.org_id = $1 AND ($2::text IS NULL OR t.status = ANY(string_to_array($2, ','))) ORDER BY t.created_at DESC LIMIT $3 OFFSET $4`,
      [req.ctx.orgId, req.query.status ?? null, req.query.limit ?? 50, req.query.offset ?? 0],
    ));

  app.post("/trips", {
    preValidation: requireRole(ROLES.dispatch),
    schema: {
      tags,
      body: z.object({
        customerId: uuid, assetId: uuid.optional(), driverName: z.string().optional(), driverPhone: z.string().optional(), origin: z.string(),
        destination: z.string(), cargo: z.string().optional(), units: z.number().int().positive().optional(), pickupDate: isoDate.optional(),
        rateNgn: kobo, waybillNo: z.string().optional(), notes: z.string().optional(),
      }),
    },
  }, async (req, reply) => {
    reply.code(201);
    return tx((db) => createTrip(db, req.ctx, req.body));
  });

  app.get("/trips/:id", { schema: { tags, params: idParams } }, async (req) => getTrip(pool, req.ctx.orgId, req.params.id));

  app.post("/trips/:id/status", {
    preValidation: requireRole(ROLES.dispatch),
    schema: { tags, params: idParams, body: z.object({ status: z.enum(["in_transit", "delivered", "cancelled"]), date: isoDate.optional() }) },
  }, async (req) => tx((db) => setTripStatus(db, req.ctx, req.params.id, req.body.status, req.body.date)));

  app.post("/trips/:id/invoice", {
    preValidation: requireRole(ROLES.sales),
    schema: { tags, params: idParams, body: z.object({ issueDate: isoDate.optional(), dueDate: isoDate.optional(), vatRateBp: rateBp.optional() }) },
  }, async (req, reply) => {
    reply.code(201);
    return tx((db) => invoiceTrip(db, req.ctx, req.params.id, req.body));
  });

  app.get("/reports/fleet-profitability", { schema: { tags, querystring: z.object({ from: isoDate.optional(), to: isoDate.optional() }) } }, async (req) =>
    fleetProfitability(pool, req.ctx.orgId, req.query.from ?? `${today().slice(0, 4)}-01-01`, req.query.to ?? today()));
};
