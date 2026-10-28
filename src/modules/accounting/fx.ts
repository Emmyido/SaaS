import type { Db } from "../../db/pool.js";
import { one } from "../../db/pool.js";
import { badRequest } from "../../lib/errors.js";

/** Resolve the NGN rate for a currency: explicit rate wins, else the latest saved rate on or before `date`. */
export async function resolveRate(db: Db, orgId: string, currency: string, date: string, explicit?: number | null): Promise<number> {
  if (currency === "NGN") return 1;
  if (explicit && explicit > 0) return explicit;
  const row = await one(
    db,
    `SELECT rate FROM fx_rates WHERE org_id = $1 AND currency = $2 AND rate_date <= $3 ORDER BY rate_date DESC LIMIT 1`,
    [orgId, currency, date],
  );
  if (!row) throw badRequest(`No ${currency} rate saved for ${date}. Pass fxRate or set today's rate under FX rates.`);
  return Number(row.rate);
}

export async function setRate(db: Db, orgId: string, currency: string, date: string, rate: number): Promise<void> {
  await db.query(
    `INSERT INTO fx_rates (org_id, currency, rate_date, rate) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, currency, rate_date) DO UPDATE SET rate = EXCLUDED.rate`,
    [orgId, currency, date, rate],
  );
}
