import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { pool, tx, many } from "../../db/pool.js";
import { ROLES, requireRole, requireVertical } from "../../plugins/context.js";
import { idParams, isoDate, kobo, paging, uuid } from "../../lib/schemas.js";
import { addJobLine, createJobCard, getJobCard, invoiceJobCard, setJobStatus } from "./service.js";

const tags = ["Workshop"];
const line = z.object({ kind: z.enum(["labour", "part"]), itemId: uuid.optional(), description: z.string().optional(), quantity: z.number().positive().optional(), unitPrice: kobo.optional() });

export const workshopRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preValidation", requireVertical("mechanic"));

  app.get("/job-cards", { schema: { tags, querystring: paging.extend({ status: z.string().optional() }) } }, async (req) =>
    many(
      pool,
      `SELECT j.*, c.name AS customer_name FROM job_cards j JOIN contacts c ON c.id = j.customer_id
        WHERE j.org_id = $1 AND ($2::text IS NULL OR j.status = ANY(string_to_array($2, ','))) ORDER BY j.created_at DESC LIMIT $3 OFFSET $4`,
      [req.ctx.orgId, req.query.status ?? null, req.query.limit ?? 50, req.query.offset ?? 0],
    ));

  app.post("/job-cards", {
    preValidation: requireRole(ROLES.workshop),
    schema: {
      tags,
      body: z.object({
        customerId: uuid, itemId: uuid.optional(), vehicleDesc: z.string().optional(), vin: z.string().optional(), plateNumber: z.string().optional(),
        odometerKm: z.number().int().optional(), complaint: z.string().optional(), diagnosis: z.string().optional(), assignedTo: uuid.optional(),
        promisedAt: z.string().datetime().optional(), lines: z.array(line).optional(),
      }),
    },
  }, async (req, reply) => {
    reply.code(201);
    return tx((db) => createJobCard(db, req.ctx, req.body));
  });

  app.get("/job-cards/:id", { schema: { tags, params: idParams } }, async (req) => getJobCard(pool, req.ctx.orgId, req.params.id));

  app.post("/job-cards/:id/lines", { preValidation: requireRole(ROLES.workshop), schema: { tags, params: idParams, body: line } }, async (req, reply) => {
    reply.code(201);
    return tx((db) => addJobLine(db, req.ctx, req.params.id, req.body));
  });

  app.post("/job-cards/:id/status", {
    preValidation: requireRole(ROLES.workshop),
    schema: { tags, params: idParams, body: z.object({ status: z.enum(["in_progress", "completed", "cancelled"]), diagnosis: z.string().optional() }) },
  }, async (req) => tx((db) => setJobStatus(db, req.ctx, req.params.id, req.body.status, req.body.diagnosis)));

  app.post("/job-cards/:id/invoice", {
    preValidation: requireRole(ROLES.sales),
    schema: { tags, params: idParams, body: z.object({ issueDate: isoDate.optional(), dueDate: isoDate.optional(), discount: kobo.optional() }) },
  }, async (req, reply) => {
    reply.code(201);
    return tx((db) => invoiceJobCard(db, req.ctx, req.params.id, req.body));
  });
};
