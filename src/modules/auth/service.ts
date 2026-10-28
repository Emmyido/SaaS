import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Db } from "../../db/pool.js";
import { one, many } from "../../db/pool.js";
import { badRequest, conflict, unauthorized } from "../../lib/errors.js";
import { config } from "../../config.js";

export async function createUser(db: Db, input: { email: string; password?: string; fullName: string; phone?: string; greenrevUserId?: string }) {
  const email = input.email.trim().toLowerCase();
  if (await one(db, `SELECT 1 FROM users WHERE email = $1`, [email])) throw conflict("An account with this email already exists");
  return one(
    db,
    `INSERT INTO users (email, password_hash, full_name, phone, greenrev_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, full_name, phone`,
    [email, input.password ? await bcrypt.hash(input.password, 10) : null, input.fullName, input.phone ?? null, input.greenrevUserId ?? null],
  );
}

export async function verifyLogin(db: Db, email: string, password: string) {
  const user = await one(db, `SELECT * FROM users WHERE email = $1`, [email.trim().toLowerCase()]);
  if (!user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) throw unauthorized("Invalid email or password");
  return user;
}

export async function userOrgs(db: Db, userId: string) {
  return many(
    db,
    `SELECT o.id, o.name, o.slug, o.plan, o.plan_status, o.verticals, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 ORDER BY o.created_at`,
    [userId],
  );
}

/**
 * Verify an HS256 JWT minted by the existing GreenRev app (shared secret GREENREV_SSO_SECRET).
 * Expected claims: sub (GreenRev user id), email, name, optional phone, exp.
 */
export function verifyGreenRevToken(token: string): { sub: string; email: string; name: string; phone?: string } {
  if (!config.greenrev.ssoSecret) throw badRequest("GreenRev single sign-on is not configured");
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthorized("Malformed GreenRev token");
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  if (header.alg !== "HS256") throw unauthorized("Unsupported GreenRev token algorithm");
  const expected = crypto.createHmac("sha256", config.greenrev.ssoSecret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw unauthorized("Invalid GreenRev token");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw unauthorized("GreenRev token expired");
  if (!claims.sub || !claims.email) throw unauthorized("GreenRev token is missing sub/email");
  return { sub: String(claims.sub), email: String(claims.email), name: String(claims.name ?? claims.email), phone: claims.phone };
}

/** Find or link the Business Suite user for a GreenRev account. */
export async function upsertGreenRevUser(db: Db, claims: { sub: string; email: string; name: string; phone?: string }) {
  const bySub = await one(db, `SELECT id, email, full_name FROM users WHERE greenrev_user_id = $1`, [claims.sub]);
  if (bySub) return bySub;
  const byEmail = await one(db, `SELECT id, email, full_name, greenrev_user_id FROM users WHERE email = $1`, [claims.email.toLowerCase()]);
  if (byEmail) {
    if (byEmail.greenrev_user_id && byEmail.greenrev_user_id !== claims.sub) throw conflict("This email is linked to a different GreenRev account");
    await db.query(`UPDATE users SET greenrev_user_id = $2 WHERE id = $1`, [byEmail.id, claims.sub]);
    return byEmail;
  }
  return createUser(db, { email: claims.email, fullName: claims.name, phone: claims.phone, greenrevUserId: claims.sub });
}
