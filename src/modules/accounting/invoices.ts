import type { Db } from "../../db/pool.js";
import { one, many } from "../../db/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { allocate, roundMinor, vatOn } from "../../lib/money.js";
import { addDays } from "../../lib/dates.js";
import { nextNumber } from "../../lib/sequences.js";
import type { OrgContext } from "../../plugins/context.js";
import { accountId, assertAccount } from "./chart.js";
import { postEntry, reverseEntry, type LineInput } from "./ledger.js";
import { getItemForUpdate, issueStock, receiveStock, vehicleAssetKey } from "../inventory/stock.js";
import { queueMarketplaceSync } from "../marketplace/sync.js";
import { assertContact } from "../contacts/service.js";

export interface InvoiceLineInput {
  itemId?: string;
  description?: string;
  quantity?: number;
  unitPrice: number;      // kobo
  discount?: number;      // kobo off this line
  vatRateBp?: number;     // defaults to the org's VAT rate (0 when not VAT-registered)
  revenueKey?: string;    // system account key, e.g. 'service_income'
  revenueAccountId?: string;
}

export interface InvoiceInput {
  customerId: string;
  issueDate: string;
  dueDate?: string;
  lines: InvoiceLineInput[];
  /** Invoice-level discount in kobo, spread over lines in proportion to their net value. */
  discount?: number;
  notes?: string;
  sourceType?: "job_card" | "trip" | "rental";
  sourceId?: string;
}

const SOURCE_REVENUE: Record<string, string> = {
  job_card: "service_income",
  trip: "haulage_income",
  rental: "rental_income",
};

/**
 * Issue a sales invoice. Posting:
 *   Dr Accounts Receivable (total)   Dr Discounts Allowed (all discounts)
 *     Cr Revenue (gross per line)    Cr VAT Output
 *   and for stock lines: Dr Cost of Sales  Cr Inventory (landed / average cost)
 * Sold vehicles are marked sold and unpublished from the marketplace.
 */
export async function createInvoice(db: Db, ctx: OrgContext, input: InvoiceInput) {
  if (input.lines.length === 0) throw badRequest("An invoice needs at least one line");
  await assertContact(db, ctx.orgId, input.customerId, "customer");

  type Prepared = InvoiceLineInput & { qty: number; gross: number; lineDiscount: number; item?: any; revenueAccountId: string; description: string };
  const prepared: Prepared[] = [];
  const seenVehicles = new Set<string>();
  for (const l of input.lines) {
    const qty = l.quantity ?? 1;
    if (qty <= 0) throw badRequest("Quantity must be positive");
    let item: any;
    let revenueKey = l.revenueKey ?? (input.sourceType ? SOURCE_REVENUE[input.sourceType] : "other_income");
    if (l.itemId) {
      item = await getItemForUpdate(db, ctx.orgId, l.itemId);
      if (item.kind === "vehicle") {
        if (qty !== 1) throw badRequest("Vehicles are sold one per line");
        if (seenVehicles.has(item.id)) throw badRequest(`${item.title} appears twice on this invoice`);
        seenVehicles.add(item.id);
        if (["sold", "archived", "draft", "rented"].includes(item.status)) {
          throw conflict(`${item.title} cannot be sold while it is ${item.status}`);
        }
        revenueKey = l.revenueKey ?? "sales_vehicles";
      } else {
        if (!Number.isInteger(qty)) throw badRequest("Part quantities must be whole numbers");
        revenueKey = l.revenueKey ?? "sales_parts";
      }
    }
    let revenueAccountId = l.revenueAccountId;
    if (revenueAccountId) {
      const acct = await assertAccount(db, ctx.orgId, revenueAccountId);
      if (acct.type !== "income") throw badRequest("Revenue account must be an income account");
    } else {
      revenueAccountId = await accountId(db, ctx.orgId, revenueKey);
    }
    const gross = roundMinor(qty * l.unitPrice);
    const lineDiscount = l.discount ?? 0;
    if (lineDiscount < 0 || lineDiscount > gross) throw badRequest("Line discount must be between 0 and the line amount");
    prepared.push({ ...l, qty, gross, lineDiscount, item, revenueAccountId, description: l.description ?? item?.title ?? "Item" });
  }

  const extra = input.discount ?? 0;
  const nets = prepared.map((p) => p.gross - p.lineDiscount);
  if (extra < 0 || extra > nets.reduce((a, b) => a + b, 0)) throw badRequest("Invoice discount must be between 0 and the invoice value");
  const spread = allocate(extra, nets);

  const number = await nextNumber(db, ctx.orgId, "invoice");
  const invoice = await one(
    db,
    `INSERT INTO invoices (org_id, number, customer_id, issue_date, due_date, subtotal, total, notes, source_type, source_id, created_by)
     VALUES ($1,$2,$3,$4,$5,0,0,$6,$7,$8,$9) RETURNING *`,
    [ctx.orgId, number, input.customerId, input.issueDate, input.dueDate ?? addDays(input.issueDate, 0), input.notes ?? null,
      input.sourceType ?? null, input.sourceId ?? null, ctx.userId],
  );

  const ledger: LineInput[] = [];
  let subtotal = 0, discountTotal = 0, vatTotal = 0;
  const cogs = new Map<string, { debitKey: string; creditKey: string; amount: number; itemId?: string }>();

  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    const discount = p.lineDiscount + spread[i];
    const net = p.gross - discount;
    const rate = p.vatRateBp ?? ctx.vatRateBp;
    const vat = vatOn(net, rate);
    let cost = 0;
    if (p.item?.kind === "vehicle") {
      cost = p.item.landed_cost_ngn;
      await db.query(`UPDATE inventory_items SET status = 'sold', sold_at = $2, updated_at = now() WHERE id = $1`, [p.item.id, input.issueDate]);
      cogs.set(p.item.id, { debitKey: "cogs_vehicles", creditKey: vehicleAssetKey(p.item), amount: cost, itemId: p.item.id });
    } else if (p.item) {
      cost = await issueStock(db, ctx.orgId, p.item.id, p.qty, input.sourceType === "job_card" ? "job_card" : "sale", { type: "invoice", id: invoice.id });
      const prev = cogs.get("parts") ?? { debitKey: "cogs_parts", creditKey: "inventory_parts", amount: 0 };
      prev.amount += cost;
      cogs.set("parts", prev);
    }
    await db.query(
      `INSERT INTO invoice_lines (invoice_id, org_id, item_id, description, quantity, unit_price, gross, discount, vat_rate_bp, vat, total, revenue_account_id, cost_ngn)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [invoice.id, ctx.orgId, p.item?.id ?? null, p.description, p.qty, p.unitPrice, p.gross, discount, rate, vat, net + vat, p.revenueAccountId, cost],
    );
    subtotal += p.gross;
    discountTotal += discount;
    vatTotal += vat;
    ledger.push({ accountId: p.revenueAccountId, credit: p.gross, description: p.description, itemId: p.item?.id, contactId: input.customerId });
  }
  const total = subtotal - discountTotal + vatTotal;

  ledger.push({ accountId: await accountId(db, ctx.orgId, "ar"), debit: total, contactId: input.customerId, description: `Invoice ${number}` });
  ledger.push({ accountId: await accountId(db, ctx.orgId, "discounts_allowed"), debit: discountTotal, contactId: input.customerId });
  ledger.push({ accountId: await accountId(db, ctx.orgId, "vat_output"), credit: vatTotal, description: "Output VAT" });
  for (const c of cogs.values()) {
    if (!c.amount) continue;
    ledger.push({ accountId: await accountId(db, ctx.orgId, c.debitKey), debit: c.amount, itemId: c.itemId });
    ledger.push({ accountId: await accountId(db, ctx.orgId, c.creditKey), credit: c.amount, itemId: c.itemId });
  }

  const entryId = await postEntry(db, ctx.orgId, {
    date: input.issueDate,
    memo: `Invoice ${number}`,
    sourceType: "invoice",
    sourceId: invoice.id,
    createdBy: ctx.userId,
    lines: ledger,
  });
  await db.query(
    `UPDATE invoices SET subtotal = $2, discount_total = $3, vat_total = $4, total = $5, journal_entry_id = $6 WHERE id = $1`,
    [invoice.id, subtotal, discountTotal, vatTotal, total, entryId],
  );
  for (const p of prepared) if (p.item) await queueMarketplaceSync(db, ctx.orgId, p.item.id);
  return getInvoice(db, ctx.orgId, invoice.id);
}

export async function getInvoice(db: Db, orgId: string, id: string) {
  const inv = await one(
    db,
    `SELECT i.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, c.address AS customer_address
       FROM invoices i JOIN contacts c ON c.id = i.customer_id WHERE i.id = $1 AND i.org_id = $2`,
    [id, orgId],
  );
  if (!inv) throw notFound("Invoice");
  inv.lines = await many(
    db,
    `SELECT l.*, it.vin, it.make, it.model, it.year, it.color FROM invoice_lines l LEFT JOIN inventory_items it ON it.id = l.item_id
      WHERE l.invoice_id = $1 ORDER BY l.id`,
    [id],
  );
  inv.balance = inv.total + inv.finance_charges - inv.amount_paid - inv.amount_credited;
  inv.payments = await many(
    db,
    `SELECT p.id, p.number, p.payment_date, p.method, pa.amount, pa.discount FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id WHERE pa.invoice_id = $1 ORDER BY p.payment_date`,
    [id],
  );
  const plan = await one(db, `SELECT id FROM installment_plans WHERE invoice_id = $1`, [id]);
  inv.installment_plan_id = plan?.id ?? null;
  return inv;
}

/** Void an unpaid invoice: reverse the ledger entry and put stock back. */
export async function voidInvoice(db: Db, ctx: OrgContext, id: string, date: string) {
  const inv = await one(db, `SELECT * FROM invoices WHERE id = $1 AND org_id = $2 FOR UPDATE`, [id, ctx.orgId]);
  if (!inv) throw notFound("Invoice");
  if (inv.status === "void") throw conflict("Invoice is already void");
  if (inv.amount_paid > 0 || inv.amount_credited > 0) throw conflict("Refund or reverse payments on this invoice before voiding it");
  const plan = await one(db, `SELECT id FROM installment_plans WHERE invoice_id = $1 AND status = 'active'`, [id]);
  if (plan) {
    const extra = await many(db, `SELECT id FROM journal_entries WHERE source_type = 'installment_plan' AND source_id = $1`, [plan.id]);
    for (const e of extra) await reverseEntry(db, ctx.orgId, e.id, date, `Cancel installment plan on ${inv.number}`, ctx.userId);
    await db.query(`UPDATE installment_plans SET status = 'cancelled' WHERE id = $1`, [plan.id]);
  }
  const lines = await many(db, `SELECT l.*, it.kind FROM invoice_lines l LEFT JOIN inventory_items it ON it.id = l.item_id WHERE invoice_id = $1`, [id]);
  for (const l of lines) {
    if (!l.item_id) continue;
    if (l.kind === "vehicle") {
      await db.query(`UPDATE inventory_items SET status = 'in_stock', sold_at = NULL, updated_at = now() WHERE id = $1`, [l.item_id]);
    } else if (l.cost_ngn > 0 || Number(l.quantity) > 0) {
      await receiveStock(db, ctx.orgId, l.item_id, Number(l.quantity), l.cost_ngn, "void", { type: "invoice", id });
    }
    await queueMarketplaceSync(db, ctx.orgId, l.item_id);
  }
  await reverseEntry(db, ctx.orgId, inv.journal_entry_id, date, `Void invoice ${inv.number}`, ctx.userId);
  await db.query(`UPDATE invoices SET status = 'void' WHERE id = $1`, [id]);
  return getInvoice(db, ctx.orgId, id);
}
