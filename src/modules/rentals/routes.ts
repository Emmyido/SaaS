import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { pool, tx, many } from "../../db/pool.js";
import { ROLES, requireRole, requireVertical } from "../../plugins/context.js";
import { idParams, isoDate, kobo, method, paging, rateBp, uuid } from "../../lib/schemas.js";
import { addDays, today } from "../../lib/dates.js";
import { availability, cancelBooking, checkIn, checkOut, createBooking, getBooking, invoiceBooking, utilisation } from "./service.js";

const tags = ["Rentals"];

export const rentalRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preValidation", requireVertical("rental"));

  app.get("/rentals/availability", { schema: { tags, querystring: z.object({ from: isoDate, to: isoDate }) } }, async (req) =>
    availability(pool, req.ctx.orgId, req.query.from, req.query.to));

  app.get("/rentals", { schema: { tags, querystring: paging.extend({ status: z.string().optional() }) } }, async (req) =>
    many(
      pool,
      `SELECT b.*, c.name AS customer_name, i.title AS vehicle_title FROM rental_bookings b JOIN contacts c ON c.id = b.customer_id
         JOIN inventory_items i ON i.id = b.item_id
        WHERE b.org_id = $1 AND ($2::text IS NULL OR b.status = ANY(string_to_array($2, ','))) ORDER BY b.start_date DESC LIMIT $3 OFFSET $4`,
      [req.ctx.orgId, req.query.status ?? null, req.query.limit ?? 50, req.query.offset ?? 0],
    ));

  app.post("/rentals", {
    preValidation: requireRole(ROLES.sales),
    schema: {
      tags,
      summary: "Book a car (double-bookings are rejected)",
      body: z.object({
        customerId: uuid, itemId: uuid, startDate: isoDate, endDate: isoDate, dailyRateNgn: kobo.optional(), depositNgn: kobo.optional(),
        withDriver: z.boolean().optional(),
        collectDeposit: z.object({ method, accountId: uuid.optional(), reference: z.string().optional() }).optional(),
      }),
    },
  }, async (req, reply) => {
    reply.code(201);
    return tx((db) => createBooking(db, req.ctx, req.body));
  });

  app.get("/rentals/:id", { schema: { tags, params: idParams } }, async (req) => getBooking(pool, req.ctx.orgId, req.params.id));

  app.post("/rentals/:id/check-out", { preValidation: requireRole(ROLES.sales), schema: { tags, params: idParams, body: z.object({ mileage: z.number().int().optional() }) } },
    async (req) => tx((db) => checkOut(db, req.ctx, req.params.id, req.body.mileage)));

  app.post("/rentals/:id/check-in", {
    preValidation: requireRole(ROLES.sales),
    schema: { tags, params: idParams, body: z.object({ returnedOn: isoDate.optional(), mileage: z.number().int().optional(), damageFeeNgn: kobo.optional(), lateFeeNgn: kobo.optional() }) },
  }, async (req) => tx((db) => checkIn(db, req.ctx, req.params.id, req.body)));

  app.post("/rentals/:id/invoice", {
    preValidation: requireRole(ROLES.sales),
    schema: { tags, params: idParams, body: z.object({ issueDate: isoDate.optional(), applyDeposit: z.boolean().optional(), vatRateBp: rateBp.optional() }) },
  }, async (req, reply) => {
    reply.code(201);
    return tx((db) => invoiceBooking(db, req.ctx, req.params.id, req.body));
  });

  app.post("/rentals/:id/cancel", { preValidation: requireRole(ROLES.sales), schema: { tags, params: idParams } }, async (req) =>
    tx((db) => cancelBooking(db, req.ctx, req.params.id)));

  app.get("/reports/rental-utilisation", { schema: { tags, querystring: z.object({ from: isoDate.optional(), to: isoDate.optional() }) } }, async (req) =>
    utilisation(pool, req.ctx.orgId, req.query.from ?? addDays(today(), -30), req.query.to ?? today()));
};
