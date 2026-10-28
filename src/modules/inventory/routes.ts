import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { pool, tx } from "../../db/pool.js";
import { badRequest } from "../../lib/errors.js";
import { ROLES, requireRole } from "../../plugins/context.js";
import { currency, idParams, isoDate, kobo, paging, positiveKobo, uuid } from "../../lib/schemas.js";
import { ALLOWED_UPLOADS, saveFile } from "../../lib/storage.js";
import { addPhoto, adjustStock, createPart, createVehicle, deletePhoto, getItem, listItems, stockMovements, updateItem } from "./service.js";

const tags = ["Inventory"];
const condition = z.enum(["brand_new", "foreign_used", "nigerian_used"]);

const vehicleFields = {
  title: z.string().optional(),
  vin: z.string().min(11).max(20).optional(),
  make: z.string(),
  model: z.string(),
  year: z.number().int().min(1950).max(2100).optional(),
  trim: z.string().optional(),
  bodyType: z.string().optional(),
  color: z.string().optional(),
  mileageKm: z.number().int().nonnegative().optional(),
  fuelType: z.string().optional(),
  transmission: z.string().optional(),
  engine: z.string().optional(),
  condition: condition.optional(),
  plateNumber: z.string().optional(),
  branch: z.string().optional(),
  description: z.string().optional(),
  askingPriceNgn: kobo.optional(),
  minPriceNgn: kobo.optional(),
  isRentable: z.boolean().optional(),
  dailyRateNgn: kobo.optional(),
  publishToMarketplace: z.boolean().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
};

const vehicleBody = z.object({
  ...vehicleFields,
  status: z.enum(["draft", "in_transit", "in_stock", "in_repair"]).optional(),
  purchasedAt: isoDate.optional(),
  purchase: z.object({
    supplierId: uuid,
    currency: currency.optional(),
    amount: positiveKobo.describe("Purchase price in the purchase currency's minor units (cents for USD)"),
    fxRate: z.number().positive().optional().describe("NGN per 1 unit of currency; defaults to the saved rate for the day"),
    importDutyNgn: kobo.optional(),
    clearingNgn: kobo.optional(),
    shippingNgn: kobo.optional(),
    supplierRef: z.string().optional(),
    dueDate: isoDate.optional(),
    paidFromAccountId: uuid.optional().describe("Pay now from this cash/bank account"),
  }).optional(),
  openingCostNgn: positiveKobo.optional().describe("Onboarding: cost of a car you already own"),
});

const partBody = z.object({
  kind: z.enum(["part", "accessory"]).optional(),
  title: z.string(),
  sku: z.string().optional(),
  partNumber: z.string().optional(),
  brand: z.string().optional(),
  compatibleWith: z.array(z.string()).optional(),
  condition: condition.optional(),
  unitPriceNgn: kobo.optional(),
  reorderLevel: z.number().int().nonnegative().optional(),
  branch: z.string().optional(),
  description: z.string().optional(),
  publishToMarketplace: z.boolean().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  openingQuantity: z.number().int().nonnegative().optional(),
  openingUnitCostNgn: kobo.optional(),
});

export const inventoryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/inventory", {
    schema: {
      tags,
      querystring: paging.extend({
        kind: z.enum(["vehicle", "part", "accessory"]).optional(),
        status: z.string().optional().describe("Comma-separated statuses"),
        make: z.string().optional(),
        q: z.string().optional().describe("Search title, VIN, SKU, part number, plate"),
        rentable: z.coerce.boolean().optional(),
        lowStock: z.coerce.boolean().optional(),
      }),
    },
  }, async (req) => listItems(pool, req.ctx.orgId, req.query));

  app.post("/inventory/vehicles", { preValidation: requireRole(ROLES.sales), schema: { tags, summary: "Add a vehicle (optionally recording its purchase)", body: vehicleBody } },
    async (req, reply) => {
      reply.code(201);
      return tx((db) => createVehicle(db, req.ctx, req.body));
    });

  app.post("/inventory/parts", { preValidation: requireRole(ROLES.write), schema: { tags, summary: "Add a spare part or accessory", body: partBody } },
    async (req, reply) => {
      reply.code(201);
      return tx((db) => createPart(db, req.ctx, req.body));
    });

  app.get("/inventory/:id", { schema: { tags, params: idParams } }, async (req) => getItem(pool, req.ctx.orgId, req.params.id));

  app.patch("/inventory/:id", {
    preValidation: requireRole(ROLES.write),
    schema: {
      tags,
      params: idParams,
      body: z
        .object({ ...partBody.omit({ openingQuantity: true, openingUnitCostNgn: true, kind: true }).shape, ...vehicleFields })
        .partial()
        .extend({ status: z.enum(["draft", "in_transit", "in_stock", "reserved", "in_repair", "archived"]).optional() }),
    },
  }, async (req) => tx((db) => updateItem(db, req.ctx, req.params.id, req.body as Record<string, unknown>)));

  app.post("/inventory/:id/publish", { preValidation: requireRole(ROLES.sales), schema: { tags: ["Marketplace"], params: idParams } },
    async (req) => tx((db) => updateItem(db, req.ctx, req.params.id, { publishToMarketplace: true })));

  app.post("/inventory/:id/unpublish", { preValidation: requireRole(ROLES.sales), schema: { tags: ["Marketplace"], params: idParams } },
    async (req) => tx((db) => updateItem(db, req.ctx, req.params.id, { publishToMarketplace: false })));

  app.post("/inventory/:id/adjust-stock", {
    preValidation: requireRole(ROLES.write),
    schema: {
      tags,
      summary: "Stock count correction (parts)",
      params: idParams,
      body: z.object({ quantity: z.number().int().describe("Positive to add, negative to write off"), unitCostNgn: kobo.optional(), note: z.string().optional(), date: isoDate.optional() }),
    },
  }, async (req) => tx((db) => adjustStock(db, req.ctx, req.params.id, req.body)));

  app.get("/inventory/:id/movements", { schema: { tags, params: idParams } }, async (req) => stockMovements(pool, req.ctx.orgId, req.params.id));

  app.post("/inventory/:id/photos", {
    preValidation: requireRole(ROLES.write),
    schema: { tags, summary: "Upload photos (multipart, field name 'photos')", params: idParams, consumes: ["multipart/form-data"] },
  }, async (req, reply) => {
    const saved = [];
    for await (const part of req.files()) {
      if (!ALLOWED_UPLOADS.includes(part.mimetype) || part.mimetype === "application/pdf") throw badRequest(`Unsupported photo type ${part.mimetype}`);
      const file = await saveFile(req.ctx.orgId, await part.toBuffer(), part.mimetype);
      saved.push(await tx((db) => addPhoto(db, req.ctx, req.params.id, file.url)));
    }
    if (!saved.length) throw badRequest("No photos uploaded");
    reply.code(201);
    return saved;
  });

  app.post("/inventory/:id/photos/urls", {
    preValidation: requireRole(ROLES.write),
    schema: { tags, summary: "Attach photos already hosted elsewhere (e.g. GreenRev CDN)", params: idParams, body: z.object({ urls: z.array(z.string().url()).min(1).max(30) }) },
  }, async (req, reply) => {
    reply.code(201);
    return tx(async (db) => {
      const out = [];
      for (const url of req.body.urls) out.push(await addPhoto(db, req.ctx, req.params.id, url));
      return out;
    });
  });

  app.delete("/inventory/:id/photos/:photoId", {
    preValidation: requireRole(ROLES.write),
    schema: { tags, params: z.object({ id: uuid, photoId: uuid }) },
  }, async (req) => {
    await tx((db) => deletePhoto(db, req.ctx, req.params.id, req.params.photoId));
    return { ok: true };
  });
};
