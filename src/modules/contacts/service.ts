import type { Db } from "../../db/pool.js";
import { one } from "../../db/pool.js";
import { badRequest } from "../../lib/errors.js";

export async function assertContact(db: Db, orgId: string, id: string, role: "customer" | "supplier") {
  const c = await one(db, `SELECT id, kind, name FROM contacts WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!c) throw badRequest(`${role === "customer" ? "Customer" : "Supplier"} not found`);
  if (c.kind !== "both" && c.kind !== role) {
    throw badRequest(`${c.name} is set up as a ${c.kind}; change it to "both" to use it as a ${role}`);
  }
  return c;
}
