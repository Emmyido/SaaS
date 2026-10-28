import type { FastifyReply, FastifyRequest } from "fastify";
import { pool, one } from "../db/pool.js";
import { forbidden, paymentRequired, unauthorized } from "../lib/errors.js";
import { planHas, type Feature, type Vertical } from "../modules/billing/plans.js";

export type Role = "owner" | "admin" | "accountant" | "sales" | "mechanic" | "dispatcher" | "viewer";

export interface OrgContext {
  userId: string;
  orgId: string;
  role: Role;
  plan: string;
  planStatus: string;
  verticals: Vertical[];
  vatRateBp: number;
  vatRegistered: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    ctx: OrgContext;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; org?: string };
    user: { sub: string; org?: string };
  }
}

/** Verifies the bearer token and loads the caller's membership in the active organisation. */
export async function authenticate(req: FastifyRequest): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    throw unauthorized();
  }
  const { sub, org } = req.user;
  const orgId = (req.headers["x-org-id"] as string | undefined) ?? org;
  if (!orgId) throw unauthorized("No organisation selected");
  const row = await one(
    pool,
    `SELECT m.role, o.plan, o.plan_status, o.verticals, o.vat_rate_bp, o.vat_registered
       FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.org_id = $2`,
    [sub, orgId],
  );
  if (!row) throw forbidden("You are not a member of this organisation");
  req.ctx = {
    userId: sub,
    orgId,
    role: row.role,
    plan: row.plan,
    planStatus: row.plan_status,
    verticals: row.verticals,
    vatRateBp: row.vat_registered ? row.vat_rate_bp : 0,
    vatRegistered: row.vat_registered,
  };
}

/** Role groups used across modules. Owners and admins can always do everything. */
export const ROLES = {
  any: ["owner", "admin", "accountant", "sales", "mechanic", "dispatcher", "viewer"],
  write: ["owner", "admin", "accountant", "sales", "mechanic", "dispatcher"],
  finance: ["owner", "admin", "accountant"],
  sales: ["owner", "admin", "accountant", "sales"],
  workshop: ["owner", "admin", "mechanic", "sales"],
  dispatch: ["owner", "admin", "dispatcher", "sales"],
  admin: ["owner", "admin"],
} satisfies Record<string, Role[]>;

export function requireRole(roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!roles.includes(req.ctx.role)) throw forbidden(`This action needs one of the roles: ${roles.join(", ")}`);
  };
}

export function requireFeature(feature: Feature) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    assertFeature(req.ctx, feature);
  };
}

export function assertFeature(ctx: OrgContext, feature: Feature): void {
  if (ctx.planStatus === "cancelled") throw paymentRequired("Your subscription is cancelled. Renew to continue.");
  if (!planHas(ctx.plan, feature)) {
    throw paymentRequired(`"${feature}" is part of the Pro package. Upgrade to unlock it.`, { feature, upgradeTo: "pro" });
  }
}

export function requireVertical(vertical: Vertical) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.ctx.verticals.includes(vertical)) {
      throw forbidden(`Enable the "${vertical}" business line for this organisation first (Settings → Business lines).`);
    }
  };
}
