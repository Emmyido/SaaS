import type { Db } from "../../db/pool.js";
import { one, many } from "../../db/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { toNgn, vatOn } from "../../lib/money.js";
import { addDays } from "../../lib/dates.js";
import { nextNumber } from "../../lib/sequences.js";
import { assertFeature, type OrgContext } from "../../plugins/context.js";
import { accountId, assertAccount, EXPENSE_CATEGORIES } from "./chart.js";
import { postEntry, reverseEntry, type LineInput } from "./ledger.js";
import { resolveRate } from "./fx.js";
import { adjustLandedCost, getItemForUpdate, inventoryAccountKey, receiveStock } from "../inventory/stock.js";
import { queueMarketplaceSync } from "../marketplace/sync.js";
import { assertContact } from "../contacts/service.js";
import { payBills } from "./payments.js";

export interface BillLineInput {
  description: string;
  amount: number; // bill currency, minor units, excl. VAT
  vatRateBp?: number;
  accountId?: string;
  category?: string;
  itemId?: string;
  quantity?: number;
  capitalize?: boolean;
}

export interface BillInput {
  supplierId: string;
  supplierRef?: string;
  billDate: string;
  dueDate?: string;
  currency?: string;
  fxRate?: number;
  lines: BillLineInput[];
  category?: string;
  notes?: string;
  attachmentUrl?: string;
  /** Pay the whole bill immediately from this cash/bank account (a cash purchase). */
  paidFromAccountId?: string;
}

/**
 * Record a supplier bill. Posting:
 *   Dr expense / inventory (per line, NGN at bill rate)   Dr VAT input
 *     Cr Accounts Payable (total NGN, with the foreign amount kept on the line)
 * Lines linked to a vehicle are capitalised into its landed cost; part lines with a quantity receive stock.
 */
export async function createBill(db: Db, ctx: OrgContext, input: BillInput) {
  const currency = input.currency ?? "NGN";
  if (currency !== "NGN") assertFeature(ctx, "multi_currency");
  if (!input.paidFromAccountId) assertFeature(ctx, "payables");
  if (input.lines.length === 0) throw badRequest("A bill needs at least one line");
  await assertContact(db, ctx.orgId, input.supplierId, "supplier");

  const rate = await resolveRate(db, ctx.orgId, currency, input.billDate, input.fxRate);
  const number = await nextNumber(db, ctx.orgId, "bill");
  const resolved: Array<BillLineInput & { accountId: string; amountNgn: number; vat: number; vatNgn: number; capitalize: boolean }> = [];

  for (const line of input.lines) {
    let acct = line.accountId;
    let capitalize = false;
    if (line.itemId) {
      const item = await getItemForUpdate(db, ctx.orgId, line.itemId);
      if (item.kind === "vehicle") {
        capitalize = line.capitalize ?? true;
        if (capitalize) acct = await accountId(db, ctx.orgId, inventoryAccountKey(item));
      } else if (line.quantity) {
        acct = await accountId(db, ctx.orgId, "inventory_parts");
      }
    }
    if (!acct) {
      const key = EXPENSE_CATEGORIES[line.category ?? input.category ?? "office"] ?? "exp_office";
      acct = await accountId(db, ctx.orgId, key);
    } else if (line.accountId) {
      await assertAccount(db, ctx.orgId, acct);
    }
    const vat = vatOn(line.amount, line.vatRateBp ?? 0);
    resolved.push({ ...line, accountId: acct, amountNgn: toNgn(line.amount, rate), vat, vatNgn: toNgn(vat, rate), capitalize });
  }

  const subtotal = resolved.reduce((s, l) => s + l.amount, 0);
  const vatTotal = resolved.reduce((s, l) => s + l.vat, 0);
  const total = subtotal + vatTotal;
  const totalNgn = resolved.reduce((s, l) => s + l.amountNgn + l.vatNgn, 0);

  const bill = await one(
    db,
    `INSERT INTO bills (org_id, number, supplier_ref, supplier_id, bill_date, due_date, currency, fx_rate, subtotal, vat_total, total,
                        total_ngn, category, notes, attachment_url, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [ctx.orgId, number, input.supplierRef ?? null, input.supplierId, input.billDate, input.dueDate ?? addDays(input.billDate, 30),
      currency, rate, subtotal, vatTotal, total, totalNgn, input.category ?? null, input.notes ?? null, input.attachmentUrl ?? null, ctx.userId],
  );

  const lines: LineInput[] = [];
  for (const l of resolved) {
    await db.query(
      `INSERT INTO bill_lines (bill_id, org_id, description, account_id, item_id, quantity, amount, amount_ngn, vat_rate_bp, vat, capitalize)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [bill.id, ctx.orgId, l.description, l.accountId, l.itemId ?? null, l.quantity ?? null, l.amount, l.amountNgn, l.vatRateBp ?? 0, l.vat, l.capitalize],
    );
    lines.push({ accountId: l.accountId, debit: l.amountNgn, description: l.description, itemId: l.itemId, currency, fxRate: rate, foreignAmount: l.amount });
    if (l.itemId && l.capitalize) {
      await adjustLandedCost(db, ctx.orgId, l.itemId, l.amountNgn);
      await queueMarketplaceSync(db, ctx.orgId, l.itemId);
    } else if (l.itemId && l.quantity) {
      await receiveStock(db, ctx.orgId, l.itemId, l.quantity, l.amountNgn, "purchase", { type: "bill", id: bill.id });
      await queueMarketplaceSync(db, ctx.orgId, l.itemId);
    }
  }
  const vatNgn = resolved.reduce((s, l) => s + l.vatNgn, 0);
  if (vatNgn) lines.push({ accountId: await accountId(db, ctx.orgId, "vat_input"), debit: vatNgn, description: "Input VAT" });
  lines.push({
    accountId: await accountId(db, ctx.orgId, "ap"),
    credit: totalNgn,
    contactId: input.supplierId,
    currency,
    fxRate: rate,
    foreignAmount: total,
    description: `Bill ${number}`,
  });

  const entryId = await postEntry(db, ctx.orgId, {
    date: input.billDate,
    memo: `Bill ${number}${input.supplierRef ? ` (${input.supplierRef})` : ""}`,
    sourceType: "bill",
    sourceId: bill.id,
    createdBy: ctx.userId,
    lines,
  });
  await db.query(`UPDATE bills SET journal_entry_id = $2 WHERE id = $1`, [bill.id, entryId]);

  if (input.paidFromAccountId) {
    await payBills(db, ctx, {
      supplierId: input.supplierId,
      date: input.billDate,
      currency,
      fxRate: rate,
      amount: total,
      accountId: input.paidFromAccountId,
      method: "transfer",
      allocations: [{ billId: bill.id, amount: total }],
    }, { skipFeatureCheck: true });
  }
  return getBill(db, ctx.orgId, bill.id);
}

export async function getBill(db: Db, orgId: string, id: string) {
  const bill = await one(db, `SELECT * FROM bills WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!bill) throw notFound("Bill");
  bill.lines = await many(db, `SELECT * FROM bill_lines WHERE bill_id = $1 ORDER BY id`, [id]);
  bill.balance = bill.total - bill.amount_paid;
  return bill;
}

export async function voidBill(db: Db, ctx: OrgContext, id: string, date: string) {
  const bill = await one(db, `SELECT * FROM bills WHERE id = $1 AND org_id = $2 FOR UPDATE`, [id, ctx.orgId]);
  if (!bill) throw notFound("Bill");
  if (bill.status === "void") throw conflict("Bill is already void");
  if (bill.amount_paid > 0) throw conflict("Reverse the payments on this bill before voiding it");
  const lines = await many(db, `SELECT * FROM bill_lines WHERE bill_id = $1`, [id]);
  for (const l of lines) {
    if (l.item_id && l.capitalize) {
      await adjustLandedCost(db, ctx.orgId, l.item_id, -l.amount_ngn);
      await queueMarketplaceSync(db, ctx.orgId, l.item_id);
    } else if (l.item_id && l.quantity) {
      const item = await getItemForUpdate(db, ctx.orgId, l.item_id);
      if (item.quantity < l.quantity) throw conflict(`Stock from this bill has already been sold (${item.title})`);
      await db.query(`UPDATE inventory_items SET quantity = quantity - $2 WHERE id = $1`, [l.item_id, l.quantity]);
      await db.query(
        `INSERT INTO stock_movements (org_id, item_id, quantity, unit_cost_ngn, reason, source_type, source_id) VALUES ($1,$2,$3,$4,'void','bill',$5)`,
        [ctx.orgId, l.item_id, -l.quantity, Math.round(l.amount_ngn / l.quantity), id],
      );
      await queueMarketplaceSync(db, ctx.orgId, l.item_id);
    }
  }
  await reverseEntry(db, ctx.orgId, bill.journal_entry_id, date, `Void bill ${bill.number}`, ctx.userId);
  await db.query(`UPDATE bills SET status = 'void' WHERE id = $1`, [id]);
  return getBill(db, ctx.orgId, id);
}
