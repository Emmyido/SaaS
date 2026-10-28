import crypto from "node:crypto";
import type { Db } from "../../db/pool.js";
import { one, many } from "../../db/pool.js";
import { badRequest, conflict, forbidden, notFound, paymentRequired } from "../../lib/errors.js";
import { seedChart } from "../accounting/chart.js";
import { getPlan, type Vertical } from "../billing/plans.js";
import type { OrgContext, Role } from "../../plugins/context.js";
import { createUser } from "../auth/service.js";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "business";
}

export async function createOrganization(db: Db, ownerId: string, input: { name: string; verticals: Vertical[]; plan?: "starter" | "pro"; phone?: string; city?: string; state?: string }) {
  const plan = input.plan ?? "starter";
  assertVerticalsAllowed(plan, input.verticals);
  let slug = slugify(input.name);
  if (await one(db, `SELECT 1 FROM organizations WHERE slug = $1`, [slug])) slug = `${slug}-${crypto.randomBytes(3).toString("hex")}`;
  const org = await one(
    db,
    `INSERT INTO organizations (name, slug, verticals, plan, plan_status, plan_renews_at, phone, whatsapp, city, state)
     VALUES ($1,$2,$3,$4,'trialing', now() + interval '14 days', $5, $5, $6, $7) RETURNING *`,
    [input.name, slug, input.verticals, plan, input.phone ?? null, input.city ?? null, input.state ?? null],
  );
  await db.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [org.id, ownerId]);
  await seedChart(db, org.id);
  return org;
}

export function assertVerticalsAllowed(plan: string, verticals: string[]) {
  if (verticals.length === 0) throw badRequest("Choose at least one business line");
  const max = getPlan(plan).limits.verticals;
  if (max !== null && verticals.length > max) {
    throw paymentRequired(`The ${getPlan(plan).name} package covers ${max} business line. Upgrade to Pro to run ${verticals.join(" + ")} together.`, { upgradeTo: "pro" });
  }
}

const SETTINGS: Record<string, string> = {
  name: "name", phone: "phone", whatsapp: "whatsapp", email: "email", address: "address", city: "city", state: "state", tin: "tin",
  rcNumber: "rc_number", logoUrl: "logo_url", vatRegistered: "vat_registered", vatRateBp: "vat_rate_bp", autoPublish: "auto_publish",
  greenrevSellerId: "greenrev_seller_id", verticals: "verticals",
};

export async function updateSettings(db: Db, ctx: OrgContext, patch: Record<string, unknown>) {
  if (patch.verticals) assertVerticalsAllowed(ctx.plan, patch.verticals as string[]);
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!SETTINGS[k] || v === undefined) continue;
    values.push(v);
    sets.push(`${SETTINGS[k]} = $${values.length + 1}`);
  }
  if (sets.length) await db.query(`UPDATE organizations SET ${sets.join(", ")} WHERE id = $1`, [ctx.orgId, ...values]);
  return getOrganization(db, ctx.orgId);
}

export async function getOrganization(db: Db, orgId: string) {
  const org = await one(db, `SELECT * FROM organizations WHERE id = $1`, [orgId]);
  if (!org) throw notFound("Organisation");
  const plan = getPlan(org.plan);
  const usage = await one(
    db,
    `SELECT (SELECT count(*) FROM memberships WHERE org_id = $1)::int AS users,
            (SELECT count(*) FROM inventory_items WHERE org_id = $1 AND kind = 'vehicle' AND status NOT IN ('sold', 'archived'))::int AS vehicles,
            (SELECT count(*) FROM inventory_items WHERE org_id = $1 AND kind <> 'vehicle' AND status <> 'archived')::int AS parts,
            (SELECT count(*) FROM ai_usage WHERE org_id = $1 AND created_at >= date_trunc('month', now()))::int AS ai_credits`,
    [orgId],
  );
  return { ...org, planDetails: plan, usage };
}

export async function listMembers(db: Db, orgId: string) {
  return many(
    db,
    `SELECT u.id, u.email, u.full_name, u.phone, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at`,
    [orgId],
  );
}

export async function inviteMember(db: Db, ctx: OrgContext, email: string, role: Role) {
  if (role === "owner") throw badRequest("Transfer ownership instead of inviting a second owner");
  const plan = getPlan(ctx.plan);
  const count = await one(db, `SELECT count(*)::int AS n FROM memberships WHERE org_id = $1`, [ctx.orgId]);
  if (plan.limits.users !== null && count.n >= plan.limits.users) {
    throw paymentRequired(`Your ${plan.name} package allows ${plan.limits.users} team members.`, { upgradeTo: "pro" });
  }
  const normalized = email.trim().toLowerCase();
  const existing = await one(db, `SELECT id FROM users WHERE email = $1`, [normalized]);
  if (existing) {
    if (await one(db, `SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2`, [ctx.orgId, existing.id])) throw conflict("Already a member");
    await db.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,$3)`, [ctx.orgId, existing.id, role]);
    return { added: true, email: normalized, role };
  }
  const token = crypto.randomBytes(24).toString("base64url");
  await db.query(
    `INSERT INTO invites (token, org_id, email, role, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '7 days')`,
    [token, ctx.orgId, normalized, role, ctx.userId],
  );
  // The app sends this link by email/WhatsApp.
  return { added: false, email: normalized, role, inviteToken: token };
}

export async function acceptInvite(db: Db, token: string, input: { fullName: string; password: string; phone?: string }) {
  const inv = await one(db, `SELECT * FROM invites WHERE token = $1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE`, [token]);
  if (!inv) throw badRequest("This invite link is invalid or has expired");
  const user = await createUser(db, { email: inv.email, password: input.password, fullName: input.fullName, phone: input.phone });
  await db.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,$3)`, [inv.org_id, user!.id, inv.role]);
  await db.query(`UPDATE invites SET accepted_at = now() WHERE token = $1`, [token]);
  return { user, orgId: inv.org_id };
}

export async function changeRole(db: Db, ctx: OrgContext, userId: string, role: Role) {
  if (userId === ctx.userId) throw badRequest("You cannot change your own role");
  const target = await one(db, `SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2`, [ctx.orgId, userId]);
  if (!target) throw notFound("Member");
  if (target.role === "owner" || role === "owner") throw forbidden("Ownership changes need the owner to transfer it");
  await db.query(`UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2`, [ctx.orgId, userId, role]);
}

export async function removeMember(db: Db, ctx: OrgContext, userId: string) {
  const target = await one(db, `SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2`, [ctx.orgId, userId]);
  if (!target) throw notFound("Member");
  if (target.role === "owner") throw forbidden("The owner cannot be removed");
  await db.query(`DELETE FROM memberships WHERE org_id = $1 AND user_id = $2`, [ctx.orgId, userId]);
}
