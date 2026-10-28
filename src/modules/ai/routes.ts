import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { pool, tx } from "../../db/pool.js";
import { badRequest } from "../../lib/errors.js";
import { ALLOWED_UPLOADS, saveFile } from "../../lib/storage.js";
import { ROLES, requireRole } from "../../plugins/context.js";
import { idParams } from "../../lib/schemas.js";
import { getOrganization } from "../orgs/service.js";
import { addPhoto, createVehicle, getItem } from "../inventory/service.js";
import type { ImageInput } from "./claude.js";
import { decodeVin, extractDocument, identifyPart, scanVin, vehicleIntake, writeListing } from "./features.js";

const tags = ["AI"];

/** Collect uploaded files from a multipart request (field names are ignored). */
async function uploads(req: FastifyRequest, opts: { allowPdf?: boolean; keep?: boolean } = {}) {
  const files: Array<ImageInput & { data: Buffer; mimeType: string; url?: string }> = [];
  const fields: Record<string, string> = {};
  for await (const part of req.parts()) {
    if (part.type === "field") {
      fields[part.fieldname] = String(part.value);
      continue;
    }
    if (!ALLOWED_UPLOADS.includes(part.mimetype) || (!opts.allowPdf && part.mimetype === "application/pdf")) {
      throw badRequest(`Unsupported file type ${part.mimetype}`);
    }
    const data = await part.toBuffer();
    const entry: ImageInput & { data: Buffer; mimeType: string; url?: string } = { data, mimeType: part.mimetype };
    if (opts.keep) entry.url = (await saveFile(req.ctx.orgId, data, part.mimetype)).url;
    files.push(entry);
  }
  if (!files.length) throw badRequest("Attach at least one file");
  return { files, fields };
}

export const aiRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/ai/vin/:vin", { schema: { tags, summary: "Decode a typed VIN (free, no AI credit)", params: z.object({ vin: z.string().min(11).max(20) }) } },
    async (req) => decodeVin(req.params.vin));

  app.post("/ai/vin-scan", {
    preValidation: requireRole(ROLES.write),
    schema: { tags, summary: "VIN camera scanner: photo of the VIN plate → decoded vehicle", consumes: ["multipart/form-data"] },
  }, async (req) => {
    const { files } = await uploads(req);
    return scanVin(req.ctx, files[0]);
  });

  app.post("/ai/vehicle-intake", {
    preValidation: requireRole(ROLES.write),
    schema: {
      tags,
      summary: "Smart upload: photos of a car → pre-filled vehicle record",
      description: "Multipart photos (exterior, interior, dashboard, VIN plate). Send field `create=true` to save a draft vehicle with these photos attached.",
      consumes: ["multipart/form-data"],
    },
  }, async (req, reply) => {
    const { files, fields } = await uploads(req, { keep: true });
    const result = await vehicleIntake(req.ctx, files);
    if (fields.create !== "true") return { ...result, photoUrls: files.map((f) => f.url) };
    const d = result.draft;
    const item = await tx(async (db) => {
      const v = await createVehicle(db, req.ctx, {
        status: "draft",
        vin: d.vin && d.vin.length === 17 ? d.vin : undefined,
        make: d.make ?? "Unknown",
        model: d.model ?? "Unknown",
        year: d.year ?? undefined,
        trim: d.trim ?? undefined,
        bodyType: d.bodyType ?? undefined,
        color: d.color ?? undefined,
        transmission: d.transmission ?? undefined,
        fuelType: d.fuelType ?? undefined,
        mileageKm: d.mileageKm ?? undefined,
        plateNumber: d.plateNumber ?? undefined,
        condition: d.condition ?? undefined,
        engine: d.engine ?? undefined,
        title: result.ai.suggestedTitle,
        attributes: { aiFeatures: result.ai.features, aiDamage: result.ai.visibleDamage, aiNotes: result.ai.notes },
      });
      for (const [i, f] of files.entries()) {
        const role = result.ai.photoRoles.find((r) => r.index === i)?.role;
        // Don't publish photos of the VIN plate or documents.
        if (role === "vin_plate" || role === "document") continue;
        await addPhoto(db, req.ctx, v.id, f.url!, { role });
      }
      return getItem(db, req.ctx.orgId, v.id);
    });
    reply.code(201);
    return { ...result, item };
  });

  app.post("/ai/listing/:id", {
    preValidation: requireRole(ROLES.sales),
    schema: { tags, summary: "Write the marketplace listing for an item", params: idParams, body: z.object({ tone: z.enum(["professional", "friendly", "premium"]).optional(), save: z.boolean().optional() }) },
  }, async (req) => writeListing(req.ctx, req.params.id, req.body));

  app.post("/ai/document", {
    preValidation: requireRole(ROLES.write),
    schema: { tags, summary: "Read a receipt, supplier invoice or customs assessment → draft expense/bill", consumes: ["multipart/form-data"] },
  }, async (req) => {
    const { files } = await uploads(req, { allowPdf: true, keep: true });
    const result = await extractDocument(req.ctx, files[0]);
    const attachment = files[0].url;
    if (result.proposal.kind === "expense") (result.proposal.payload as any).receiptUrl = attachment;
    else (result.proposal.payload as any).attachmentUrl = attachment;
    return result;
  });

  app.post("/ai/part-identify", {
    preValidation: requireRole(ROLES.write),
    schema: { tags, summary: "Photo of a spare part → catalogue entry", consumes: ["multipart/form-data"] },
  }, async (req) => {
    const { files } = await uploads(req);
    return identifyPart(req.ctx, files);
  });

  app.get("/ai/credits", { schema: { tags } }, async (req) => {
    const org = await getOrganization(pool, req.ctx.orgId);
    return { used: org.usage.ai_credits, limit: org.planDetails.limits.aiCreditsMonthly };
  });
};
