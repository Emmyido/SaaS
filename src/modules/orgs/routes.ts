import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { pool, tx, many, one } from "../../db/pool.js";
import { ROLES, requireRole } from "../../plugins/context.js";
import { isoDate, rateBp, currency } from "../../lib/schemas.js";
import { today } from "../../lib/dates.js";
import { VERTICALS, PLANS } from "../billing/plans.js";
import { initializeCheckout } from "../billing/paystack.js";
import { setRate } from "../accounting/fx.js";
import { changeRole, getOrganization, inviteMember, listMembers, removeMember, updateSettings } from "./service.js";

const role = z.enum(["admin", "accountant", "sales", "mechanic", "dispatcher", "viewer"]);

export const orgRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/me", { schema: { tags: ["Organisation"], summary: "Current user, organisation, role and plan usage" } }, async (req) => {
    const user = await one(pool, `SELECT id, email, full_name, phone, greenrev_user_id FROM users WHERE id = $1`, [req.ctx.userId]);
    return { user, role: req.ctx.role, organization: await getOrganization(pool, req.ctx.orgId) };
  });

  app.patch("/organization", {
    preValidation: requireRole(ROLES.admin),
    schema: {
      tags: ["Organisation"],
      body: z.object({
        name: z.string().optional(), phone: z.string().optional(), whatsapp: z.string().optional(), email: z.string().email().optional(),
        address: z.string().optional(), city: z.string().optional(), state: z.string().optional(), tin: z.string().optional(),
        rcNumber: z.string().optional(), logoUrl: z.string().url().optional(), vatRegistered: z.boolean().optional(), vatRateBp: rateBp.optional(),
        autoPublish: z.boolean().optional().describe("List new stock on greenrevs.com automatically"),
        greenrevSellerId: z.string().optional().describe("Seller id of this business on the GreenRev marketplace"),
        verticals: z.array(z.enum(VERTICALS)).min(1).optional(),
      }),
    },
  }, async (req) => tx((db) => updateSettings(db, req.ctx, req.body)));

  app.get("/organization/members", { schema: { tags: ["Organisation"] } }, async (req) => listMembers(pool, req.ctx.orgId));

  app.post("/organization/members", {
    preValidation: requireRole(ROLES.admin),
    schema: { tags: ["Organisation"], body: z.object({ email: z.string().email(), role }) },
  }, async (req) => tx((db) => inviteMember(db, req.ctx, req.body.email, req.body.role)));

  app.patch("/organization/members/:userId", {
    preValidation: requireRole(ROLES.admin),
    schema: { tags: ["Organisation"], params: z.object({ userId: z.string().uuid() }), body: z.object({ role }) },
  }, async (req) => {
    await tx((db) => changeRole(db, req.ctx, req.params.userId, req.body.role));
    return { ok: true };
  });

  app.delete("/organization/members/:userId", {
    preValidation: requireRole(ROLES.admin),
    schema: { tags: ["Organisation"], params: z.object({ userId: z.string().uuid() }) },
  }, async (req) => {
    await tx((db) => removeMember(db, req.ctx, req.params.userId));
    return { ok: true };
  });

  // ---- FX rates
  app.get("/fx-rates", { schema: { tags: ["Accounting"], summary: "Latest saved FX rates" } }, async (req) =>
    many(pool, `SELECT DISTINCT ON (currency) currency, rate_date, rate FROM fx_rates WHERE org_id = $1 ORDER BY currency, rate_date DESC`, [req.ctx.orgId]));

  app.put("/fx-rates", {
    preValidation: requireRole(ROLES.finance),
    schema: {
      tags: ["Accounting"],
      summary: "Set the day's rate (NGN per unit)",
      body: z.object({ rates: z.array(z.object({ currency, rate: z.number().positive(), date: isoDate.optional() })).min(1) }),
    },
  }, async (req) => {
    await tx(async (db) => {
      for (const r of req.body.rates) await setRate(db, req.ctx.orgId, r.currency, r.date ?? today(), r.rate);
    });
    return { ok: true };
  });

  // ---- Billing
  app.get("/billing/subscription", { schema: { tags: ["Billing"] } }, async (req) => {
    const org = await getOrganization(pool, req.ctx.orgId);
    return { plan: org.plan, status: org.plan_status, renewsAt: org.plan_renews_at, details: PLANS[org.plan as "starter" | "pro"], usage: org.usage };
  });

  app.post("/billing/checkout", {
    preValidation: requireRole(["owner"]),
    schema: { tags: ["Billing"], summary: "Start a Paystack checkout to subscribe or upgrade", body: z.object({ plan: z.enum(["starter", "pro"]), interval: z.enum(["monthly", "yearly"]).default("monthly") }) },
  }, async (req) => {
    const user = await one(pool, `SELECT email FROM users WHERE id = $1`, [req.ctx.userId]);
    return initializeCheckout(req.ctx.orgId, user.email, req.body.plan, req.body.interval);
  });
};
