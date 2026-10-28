import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { pool, tx } from "../../db/pool.js";
import { forbidden } from "../../lib/errors.js";
import { VERTICALS } from "../billing/plans.js";
import { createOrganization, acceptInvite } from "../orgs/service.js";
import { createUser, upsertGreenRevUser, userOrgs, verifyGreenRevToken, verifyLogin } from "./service.js";

const tags = ["Auth"];

/** Public auth endpoints. */
export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const sign = (userId: string, orgId?: string) => app.jwt.sign({ sub: userId, org: orgId }, { expiresIn: "30d" });

  app.post("/auth/register", {
    schema: {
      tags,
      summary: "Create an account and a business",
      body: z.object({
        email: z.string().email(),
        password: z.string().min(8),
        fullName: z.string().min(2),
        phone: z.string().optional(),
        business: z.object({
          name: z.string().min(2),
          verticals: z.array(z.enum(VERTICALS)).min(1),
          plan: z.enum(["starter", "pro"]).optional(),
          city: z.string().optional(),
          state: z.string().optional(),
        }),
      }),
    },
  }, async (req, reply) => {
    const { business, ...u } = req.body;
    const result = await tx(async (db) => {
      const user = await createUser(db, u);
      const org = await createOrganization(db, user!.id, { ...business, phone: u.phone });
      return { user, org };
    });
    reply.code(201);
    return { token: sign(result.user!.id, result.org.id), user: result.user, organization: result.org };
  });

  app.post("/auth/login", {
    schema: { tags, summary: "Email + password login", body: z.object({ email: z.string().email(), password: z.string() }) },
  }, async (req) => {
    const user = await verifyLogin(pool, req.body.email, req.body.password);
    const orgs = await userOrgs(pool, user.id);
    return { token: sign(user.id, orgs[0]?.id), user: { id: user.id, email: user.email, full_name: user.full_name }, organizations: orgs };
  });

  app.post("/auth/greenrev", {
    schema: {
      tags,
      summary: "Single sign-on from the GreenRev app",
      description: "Exchange a GreenRev-issued HS256 JWT (claims: sub, email, name, exp) for a Business Suite token. Creates the user on first use.",
      body: z.object({ token: z.string() }),
    },
  }, async (req) => {
    const claims = verifyGreenRevToken(req.body.token);
    const user = await tx((db) => upsertGreenRevUser(db, claims));
    const orgs = await userOrgs(pool, user!.id);
    return { token: sign(user!.id, orgs[0]?.id), user, organizations: orgs, needsOnboarding: orgs.length === 0 };
  });

  app.post("/auth/accept-invite", {
    schema: { tags, body: z.object({ token: z.string(), fullName: z.string().min(2), password: z.string().min(8), phone: z.string().optional() }) },
  }, async (req) => {
    const { user, orgId } = await tx((db) => acceptInvite(db, req.body.token, req.body));
    return { token: sign(user!.id, orgId), user };
  });

  app.post("/auth/switch-org", {
    schema: { tags, summary: "Get a token scoped to another of your organisations", body: z.object({ orgId: z.string().uuid() }) },
  }, async (req) => {
    await req.jwtVerify();
    const orgs = await userOrgs(pool, req.user.sub);
    if (!orgs.some((o) => o.id === req.body.orgId)) throw forbidden("You are not a member of that organisation");
    return { token: sign(req.user.sub, req.body.orgId) };
  });

  app.post("/auth/organizations", {
    schema: {
      tags,
      summary: "Create another business under your account",
      body: z.object({ name: z.string().min(2), verticals: z.array(z.enum(VERTICALS)).min(1), plan: z.enum(["starter", "pro"]).optional() }),
    },
  }, async (req, reply) => {
    await req.jwtVerify();
    const org = await tx((db) => createOrganization(db, req.user.sub, req.body));
    reply.code(201);
    return { token: sign(req.user.sub, org.id), organization: org };
  });
};
