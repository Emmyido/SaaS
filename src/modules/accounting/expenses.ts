import type { Db } from "../../db/pool.js";
import { one } from "../../db/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { vatOn } from "../../lib/money.js";
import type { OrgContext } from "../../plugins/context.js";
import { accountId, assertAccount, EXPENSE_CATEGORIES } from "./chart.js";
import { postEntry, reverseEntry } from "./ledger.js";
import { adjustLandedCost, getItemForUpdate, vehicleAssetKey } from "../inventory/stock.js";
import { queueMarketplaceSync } from "../marketplace/sync.js";
import type { Method } from "./payments.js";

export interface ExpenseInput {
  date: string;
  category: string;          // key of EXPENSE_CATEGORIES
  accountId?: string;        // overrides the category's account
  description: string;
  amount: number;            // kobo, excl. VAT
  vat?: number;              // kobo of input VAT, or use vatRateBp
  vatRateBp?: number;
  method?: Method;
  paidFromAccountId?: string;
  itemId?: string;           // vehicle this cost belongs to
  capitalize?: boolean;      // default: true for unsold vehicles (adds to landed cost)
  tripId?: string;
  jobCardId?: string;
  supplierId?: string;
  receiptUrl?: string;
}

/**
 * A cash expense. Posting:
 *   Dr Expense (or Vehicle Inventory when capitalised)  Dr VAT Input
 *     Cr Cash/Bank
 */
export async function createExpense(db: Db, ctx: OrgContext, input: ExpenseInput) {
  let acct: string;
  let capitalize = false;
  if (input.itemId) {
    const item = await getItemForUpdate(db, ctx.orgId, input.itemId);
    capitalize = input.capitalize ?? (item.kind === "vehicle" && item.status !== "sold");
    if (capitalize && item.kind !== "vehicle") throw badRequest("Only vehicle costs can be capitalised");
    acct = capitalize ? await accountId(db, ctx.orgId, vehicleAssetKey(item)) : "";
  } else {
    acct = "";
  }
  if (!acct) {
    if (input.accountId) {
      const a = await assertAccount(db, ctx.orgId, input.accountId);
      if (a.type !== "expense" && a.type !== "asset") throw badRequest("Expense account must be an expense or asset account");
      acct = input.accountId;
    } else {
      const key = EXPENSE_CATEGORIES[input.category];
      if (!key) throw badRequest(`Unknown expense category "${input.category}". Use one of: ${Object.keys(EXPENSE_CATEGORIES).join(", ")}`);
      acct = await accountId(db, ctx.orgId, key);
    }
  }
  if (input.tripId && !(await one(db, `SELECT 1 FROM trips WHERE id = $1 AND org_id = $2`, [input.tripId, ctx.orgId]))) throw notFound("Trip");
  if (input.jobCardId && !(await one(db, `SELECT 1 FROM job_cards WHERE id = $1 AND org_id = $2`, [input.jobCardId, ctx.orgId]))) throw notFound("Job card");

  const paidFrom = input.paidFromAccountId ?? (await accountId(db, ctx.orgId, (input.method ?? "cash") === "cash" ? "cash" : "bank"));
  if (input.paidFromAccountId) await assertAccount(db, ctx.orgId, paidFrom, { cashOrBank: true });
  const vat = input.vat ?? vatOn(input.amount, input.vatRateBp ?? 0);

  const exp = await one(
    db,
    `INSERT INTO expenses (org_id, expense_date, category, description, account_id, paid_from_account_id, amount_ngn, vat_ngn, item_id, trip_id, job_card_id,
                           capitalize, supplier_id, receipt_url, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [ctx.orgId, input.date, input.category, input.description, acct, paidFrom, input.amount, vat, input.itemId ?? null, input.tripId ?? null,
      input.jobCardId ?? null, capitalize, input.supplierId ?? null, input.receiptUrl ?? null, ctx.userId],
  );
  const entryId = await postEntry(db, ctx.orgId, {
    date: input.date,
    memo: `Expense: ${input.description}`,
    sourceType: "expense",
    sourceId: exp.id,
    createdBy: ctx.userId,
    lines: [
      { accountId: acct, debit: input.amount, itemId: input.itemId, contactId: input.supplierId, description: input.description },
      { accountId: await accountId(db, ctx.orgId, "vat_input"), debit: vat, description: "Input VAT" },
      { accountId: paidFrom, credit: input.amount + vat, contactId: input.supplierId },
    ],
  });
  await db.query(`UPDATE expenses SET journal_entry_id = $2 WHERE id = $1`, [exp.id, entryId]);
  if (capitalize && input.itemId) {
    await adjustLandedCost(db, ctx.orgId, input.itemId, input.amount);
    await queueMarketplaceSync(db, ctx.orgId, input.itemId);
  }
  return { ...exp, journal_entry_id: entryId };
}

export async function deleteExpense(db: Db, ctx: OrgContext, id: string, date: string) {
  const exp = await one(db, `SELECT * FROM expenses WHERE id = $1 AND org_id = $2 FOR UPDATE`, [id, ctx.orgId]);
  if (!exp) throw notFound("Expense");
  if (exp.capitalize && exp.item_id) {
    const item = await getItemForUpdate(db, ctx.orgId, exp.item_id);
    if (item.status === "sold") throw conflict("This cost is already in the cost of a sold vehicle and cannot be removed");
    await adjustLandedCost(db, ctx.orgId, exp.item_id, -exp.amount_ngn);
  }
  await reverseEntry(db, ctx.orgId, exp.journal_entry_id, date, `Reverse expense: ${exp.description}`, ctx.userId);
  await db.query(`DELETE FROM expenses WHERE id = $1`, [id]);
}
