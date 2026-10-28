import type { Db } from "../db/pool.js";

const PREFIX: Record<string, string> = {
  invoice: "INV",
  bill: "BILL",
  receipt: "RCT",
  payment: "PAY",
  job_card: "JOB",
  trip: "TRP",
  rental: "RNT",
  journal: "JE",
};

/** Next document number for an organisation, e.g. INV-000042. Must run inside a transaction. */
export async function nextNumber(db: Db, orgId: string, key: keyof typeof PREFIX | string): Promise<string> {
  const n = await nextSeq(db, orgId, key);
  return `${PREFIX[key] ?? key.toUpperCase()}-${String(n).padStart(6, "0")}`;
}

export async function nextSeq(db: Db, orgId: string, key: string): Promise<number> {
  const res = await db.query(
    `INSERT INTO sequences (org_id, key, next) VALUES ($1, $2, 2)
     ON CONFLICT (org_id, key) DO UPDATE SET next = sequences.next + 1
     RETURNING next - 1 AS n`,
    [orgId, key],
  );
  return Number(res.rows[0].n);
}
