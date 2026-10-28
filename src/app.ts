import fs from "node:fs";
import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { config } from "./config.js";
import { AppError, unauthorized } from "./lib/errors.js";
import { mimeFor, resolveUploadPath } from "./lib/storage.js";
import { authenticate } from "./plugins/context.js";
import { PLANS } from "./modules/billing/plans.js";
import { handlePaystackEvent, verifyPaystackSignature } from "./modules/billing/paystack.js";
import { authRoutes } from "./modules/auth/routes.js";
import { orgRoutes } from "./modules/orgs/routes.js";
import { contactRoutes } from "./modules/contacts/routes.js";
import { inventoryRoutes } from "./modules/inventory/routes.js";
import { accountingRoutes } from "./modules/accounting/routes.js";
import { workshopRoutes } from "./modules/workshop/routes.js";
import { haulageRoutes } from "./modules/haulage/routes.js";
import { rentalRoutes } from "./modules/rentals/routes.js";
import { marketplaceRoutes, marketplaceWebhookRoutes } from "./modules/marketplace/routes.js";
import { aiRoutes } from "./modules/ai/routes.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? config.nodeEnv !== "test", bodyLimit: 5 * 1024 * 1024 }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Keep the raw JSON body for webhook signature checks.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      (err as FastifyError).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  await app.register(cors, { origin: config.corsOrigins.includes("*") ? true : config.corsOrigins });
  await app.register(jwt, { secret: config.jwtSecret });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 12 } });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "GreenRev Business Suite API",
        version: "0.1.0",
        description:
          "Inventory, operations and accounting for car dealers, mechanics, parts vendors, haulage and rental businesses, linked to the greenrevs.com marketplace. All money values are integers in kobo.",
      },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((err: FastifyError & Partial<AppError>, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: "validation_error", message: "Request is invalid", details: err.validation });
    }
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    // Postgres constraint violations that slipped past service checks
    const pg = err as unknown as { code?: string; detail?: string };
    if (pg.code === "23505") return reply.code(409).send({ error: "conflict", message: pg.detail ?? "Duplicate value" });
    if (pg.code === "23503") return reply.code(400).send({ error: "bad_reference", message: pg.detail ?? "Referenced record not found" });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code ?? "bad_request", message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: "internal_error", message: "Something went wrong" });
  });

  // ---- public
  app.get("/health", { schema: { hide: true } }, async () => ({ ok: true }));
  app.get("/plans", { schema: { tags: ["Billing"], summary: "The two packages", security: [] } }, async () => Object.values(PLANS));
  app.get("/uploads/*", { schema: { hide: true } }, async (req, reply) => {
    const full = resolveUploadPath((req.params as { "*": string })["*"]);
    if (!full || !fs.existsSync(full)) return reply.code(404).send({ error: "not_found" });
    reply.header("cache-control", "public, max-age=31536000, immutable").type(mimeFor(full));
    return reply.send(fs.createReadStream(full));
  });
  app.post("/webhooks/paystack", { schema: { hide: true } }, async (req) => {
    if (!verifyPaystackSignature(req.rawBody ?? "", req.headers["x-paystack-signature"] as string | undefined)) throw unauthorized("Bad signature");
    return handlePaystackEvent(req.body as { event: string; data: unknown } as any);
  });
  await app.register(authRoutes);
  await app.register(marketplaceWebhookRoutes);

  // ---- authenticated, tenant-scoped
  await app.register(async (scope) => {
    scope.addHook("onRequest", authenticate);
    await scope.register(orgRoutes);
    await scope.register(contactRoutes);
    await scope.register(inventoryRoutes);
    await scope.register(accountingRoutes);
    await scope.register(marketplaceRoutes);
    await scope.register(aiRoutes);
    await scope.register(workshopRoutes);
    await scope.register(haulageRoutes);
    await scope.register(rentalRoutes);
  });

  return app;
}
