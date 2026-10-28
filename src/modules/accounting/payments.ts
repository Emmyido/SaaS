import type { Db } from "../../db/pool.js";
import { one, many } from "../../db/pool.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { toNgn } from "../../lib/money.js";
import { nextNumber } from "../../lib/sequences.js";
import { assertFeature, type OrgContext } from "../../plugins/context.js";
import { accountId, assertAccount } from "./chart.js";
import { postEntry, type LineInput } from "./ledger.js";
import { resolveRate } from "./fx.js";
import { applyToInstallments } from "./installments.js";
import { assertContact } from "../contacts/service.js";

export type Method = "cash" | "transfer" | "pos" | "cheque" | "card";

async function defaultCashAccount(db: Db, orgId: string, method: Method): Promise<string> {
  const key = method === "cash" ? "cash" : method === "pos" || method === "card" ? "pos_clearing" : "bank";
  return accountId(db, orgId, key);
}

export function invoiceBalance(inv: { total: number; finance_charges: number; amount_paid: number; amount_credited: number }) {
  return inv.total + inv.finance_charges - inv.amount_paid - inv.amount_credited;
}

function invoiceStatus(inv: { total: number; finance_charges: number; amount_paid: number; amount_credited: number }) {
  const bal = invoiceBalance(inv);
  return bal <= 0 ? "paid" : inv.amount_paid + inv.amount_credited > 0 ? "partially_paid" : "issued";
}

/** Settle an invoice by `amount` cash/deposit plus `discount`; updates status and the installment schedule. */
async function settleInvoice(db: Db, orgId: string, invoiceId: string, customerId: string, amount: number, discount: number) {
  const inv = await one(db, `SELECT * FROM invoices WHERE id = $1 AND org_id = $2 FOR UPDATE`, [invoiceId, orgId]);
  if (!inv) throw notFound("Invoice");
  if (inv.customer_id !== customerId) throw badRequest(`Invoice ${inv.number} belongs to a different customer`);
  if (inv.status === "void") throw badRequest(`Invoice ${inv.number} is void`);
  const balance = invoiceBalance(inv);
  if (amount + discount > balance) {
    throw badRequest(`Allocation of ${amount + discount} exceeds the ${balance} balance on invoice ${inv.number}`);
  }
  const updated = { ...inv, amount_paid: inv.amount_paid + amount, amount_credited: inv.amount_credited + discount };
  await db.query(`UPDATE invoices SET amount_paid = $2, amount_credited = $3, status = $4 WHERE id = $1`, [
    invoiceId, updated.amount_paid, updated.amount_credited, invoiceStatus(updated),
  ]);
  await applyToInstallments(db, orgId, invoiceId, amount + discount);
  return inv;
}

export interface ReceiveInput {
  customerId: string;
  date: string;
  amount: number; // NGN kobo actually received
  method: Method;
  accountId?: string;
  reference?: string;
  /** Omit to auto-allocate to the oldest open invoices; pass [] to hold the money as a customer deposit. */
  allocations?: Array<{ invoiceId: string; amount: number; discount?: number }>;
}

/**
 * Customer payment (receipt). Posting:
 *   Dr Cash/Bank (amount)  Dr Discounts Allowed (settlement discounts)
 *     Cr Accounts Receivable (allocated + discounts)  Cr Customer Deposits (unallocated)
 */
export async function receivePayment(db: Db, ctx: OrgContext, input: ReceiveInput) {
  await assertContact(db, ctx.orgId, input.customerId, "customer");
  const cashAcct = input.accountId ?? (await defaultCashAccount(db, ctx.orgId, input.method));
  if (input.accountId) await assertAccount(db, ctx.orgId, input.accountId, { cashOrBank: true });

  let allocations = input.allocations;
  if (allocations === undefined) {
    // Auto-allocate oldest first.
    const open = await many(
      db,
      `SELECT id, total, finance_charges, amount_paid, amount_credited FROM invoices
        WHERE org_id = $1 AND customer_id = $2 AND status IN ('issued', 'partially_paid') ORDER BY due_date, issue_date, number`,
      [ctx.orgId, input.customerId],
    );
    let left = input.amount;
    allocations = [];
    for (const inv of open) {
      if (left <= 0) break;
      const take = Math.min(left, invoiceBalance(inv));
      if (take > 0) allocations.push({ invoiceId: inv.id, amount: take });
      left -= take;
    }
  }
  const allocated = allocations.reduce((s, a) => s + a.amount, 0);
  const discounts = allocations.reduce((s, a) => s + (a.discount ?? 0), 0);
  if (allocated > input.amount) throw badRequest("Allocations exceed the amount received");
  const unallocated = input.amount - allocated;

  const number = await nextNumber(db, ctx.orgId, "receipt");
  const payment = await one(
    db,
    `INSERT INTO payments (org_id, number, direction, contact_id, payment_date, currency, fx_rate, amount, amount_ngn, method, account_id, reference, unallocated_ngn, created_by)
     VALUES ($1,$2,'in',$3,$4,'NGN',1,$5,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [ctx.orgId, number, input.customerId, input.date, input.amount, input.method, cashAcct, input.reference ?? null, unallocated, ctx.userId],
  );

  const numbers: string[] = [];
  for (const a of allocations) {
    if (a.amount < 0 || (a.discount ?? 0) < 0) throw badRequest("Allocation amounts must be positive");
    const inv = await settleInvoice(db, ctx.orgId, a.invoiceId, input.customerId, a.amount, a.discount ?? 0);
    numbers.push(inv.number);
    await db.query(
      `INSERT INTO payment_allocations (payment_id, org_id, invoice_id, amount, discount) VALUES ($1,$2,$3,$4,$5)`,
      [payment.id, ctx.orgId, a.invoiceId, a.amount + (a.discount ?? 0), a.discount ?? 0],
    );
  }

  const ar = await accountId(db, ctx.orgId, "ar");
  const lines: LineInput[] = [
    { accountId: cashAcct, debit: input.amount, contactId: input.customerId },
    { accountId: await accountId(db, ctx.orgId, "discounts_allowed"), debit: discounts, contactId: input.customerId },
    { accountId: ar, credit: allocated + discounts, contactId: input.customerId },
    { accountId: await accountId(db, ctx.orgId, "customer_deposits"), credit: unallocated, contactId: input.customerId },
  ];
  const entryId = await postEntry(db, ctx.orgId, {
    date: input.date,
    memo: `Receipt ${number}${numbers.length ? ` for ${numbers.join(", ")}` : " (customer deposit)"}`,
    sourceType: "payment",
    sourceId: payment.id,
    createdBy: ctx.userId,
    lines,
  });
  await db.query(`UPDATE payments SET journal_entry_id = $2 WHERE id = $1`, [payment.id, entryId]);
  return getPayment(db, ctx.orgId, payment.id);
}

/** Customer deposit balance held for a contact, straight from the ledger. */
export async function depositBalance(db: Db, orgId: string, customerId: string): Promise<number> {
  const acct = await accountId(db, orgId, "customer_deposits");
  const row = await one(
    db,
    `SELECT COALESCE(SUM(credit - debit), 0) AS bal FROM journal_lines WHERE org_id = $1 AND account_id = $2 AND contact_id = $3`,
    [orgId, acct, customerId],
  );
  return Number(row.bal);
}

/** Use money held as a customer deposit to settle an invoice: Dr Customer Deposits, Cr AR. */
export async function applyDeposit(db: Db, ctx: OrgContext, input: { customerId: string; invoiceId: string; amount: number; date: string }) {
  const held = await depositBalance(db, ctx.orgId, input.customerId);
  if (input.amount <= 0) throw badRequest("Amount must be positive");
  if (input.amount > held) throw badRequest(`Customer only has ${held} on deposit`);
  // Deposits settle the invoice as a credit, not new cash.
  const invoice = await settleInvoice(db, ctx.orgId, input.invoiceId, input.customerId, 0, input.amount);
  const number = await nextNumber(db, ctx.orgId, "receipt");
  const payment = await one(
    db,
    `INSERT INTO payments (org_id, number, direction, contact_id, payment_date, amount, amount_ngn, method, created_by)
     VALUES ($1,$2,'in',$3,$4,$5,$5,'deposit',$6) RETURNING *`,
    [ctx.orgId, number, input.customerId, input.date, input.amount, ctx.userId],
  );
  await db.query(`INSERT INTO payment_allocations (payment_id, org_id, invoice_id, amount) VALUES ($1,$2,$3,$4)`, [
    payment.id, ctx.orgId, input.invoiceId, input.amount,
  ]);
  const entryId = await postEntry(db, ctx.orgId, {
    date: input.date,
    memo: `Deposit applied to ${invoice.number}`,
    sourceType: "payment",
    sourceId: payment.id,
    createdBy: ctx.userId,
    lines: [
      { accountId: await accountId(db, ctx.orgId, "customer_deposits"), debit: input.amount, contactId: input.customerId },
      { accountId: await accountId(db, ctx.orgId, "ar"), credit: input.amount, contactId: input.customerId },
    ],
  });
  await db.query(`UPDATE payments SET journal_entry_id = $2 WHERE id = $1`, [payment.id, entryId]);
  return getPayment(db, ctx.orgId, payment.id);
}

/** Return money held on deposit (e.g. a rental security deposit): Dr Customer Deposits, Cr Cash/Bank. */
export async function refundDeposit(db: Db, ctx: OrgContext, input: { customerId: string; amount: number; date: string; method: Method; accountId?: string; reference?: string }) {
  const held = await depositBalance(db, ctx.orgId, input.customerId);
  if (input.amount <= 0 || input.amount > held) throw badRequest(`Refund must be between 1 and ${held} kobo`);
  const cashAcct = input.accountId ?? (await defaultCashAccount(db, ctx.orgId, input.method));
  if (input.accountId) await assertAccount(db, ctx.orgId, input.accountId, { cashOrBank: true });
  const number = await nextNumber(db, ctx.orgId, "payment");
  const payment = await one(
    db,
    `INSERT INTO payments (org_id, number, direction, contact_id, payment_date, amount, amount_ngn, method, account_id, reference, created_by)
     VALUES ($1,$2,'out',$3,$4,$5,$5,$6,$7,$8,$9) RETURNING *`,
    [ctx.orgId, number, input.customerId, input.date, input.amount, input.method, cashAcct, input.reference ?? null, ctx.userId],
  );
  const entryId = await postEntry(db, ctx.orgId, {
    date: input.date,
    memo: `Deposit refund ${number}`,
    sourceType: "payment",
    sourceId: payment.id,
    createdBy: ctx.userId,
    lines: [
      { accountId: await accountId(db, ctx.orgId, "customer_deposits"), debit: input.amount, contactId: input.customerId },
      { accountId: cashAcct, credit: input.amount, contactId: input.customerId },
    ],
  });
  await db.query(`UPDATE payments SET journal_entry_id = $2 WHERE id = $1`, [payment.id, entryId]);
  return getPayment(db, ctx.orgId, payment.id);
}

export interface PayBillsInput {
  supplierId: string;
  date: string;
  currency?: string;
  fxRate?: number;    // NGN per unit on the payment date
  amount: number;     // in payment currency
  method: Method;
  accountId?: string; // NGN cash/bank account the naira leaves from
  reference?: string;
  allocations: Array<{ billId: string; amount: number; discount?: number }>;
}

/**
 * Supplier payment. AP is relieved at the bill's carrying rate; any difference against today's rate is
 * realised FX gain/loss. Posting:
 *   Dr Accounts Payable (carrying)  Dr Supplier Advances (unallocated)
 *     Cr Cash/Bank (NGN paid)  Cr Discounts Received  Cr FX Gain / Dr FX Loss
 */
export async function payBills(db: Db, ctx: OrgContext, input: PayBillsInput, opts: { skipFeatureCheck?: boolean } = {}) {
  if (!opts.skipFeatureCheck) assertFeature(ctx, "payables");
  await assertContact(db, ctx.orgId, input.supplierId, "supplier");
  const currency = input.currency ?? "NGN";
  const rate = await resolveRate(db, ctx.orgId, currency, input.date, input.fxRate);
  const cashAcct = input.accountId ?? (await defaultCashAccount(db, ctx.orgId, input.method));
  if (input.accountId) await assertAccount(db, ctx.orgId, input.accountId, { cashOrBank: true });

  const allocated = input.allocations.reduce((s, a) => s + a.amount, 0);
  if (allocated > input.amount) throw badRequest("Allocations exceed the amount paid");
  const amountNgn = toNgn(input.amount, rate);
  const number = await nextNumber(db, ctx.orgId, "payment");
  const unallocatedNgn = toNgn(input.amount - allocated, rate);
  const payment = await one(
    db,
    `INSERT INTO payments (org_id, number, direction, contact_id, payment_date, currency, fx_rate, amount, amount_ngn, method, account_id, reference, unallocated_ngn, created_by)
     VALUES ($1,$2,'out',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [ctx.orgId, number, input.supplierId, input.date, currency, rate, input.amount, amountNgn, input.method, cashAcct, input.reference ?? null, unallocatedNgn, ctx.userId],
  );

  let apDebit = 0;
  let discountNgn = 0;
  let fxNet = 0; // positive = gain
  let paidNgnAllocated = 0;
  const numbers: string[] = [];
  for (const a of input.allocations) {
    const discount = a.discount ?? 0;
    const bill = await one(db, `SELECT * FROM bills WHERE id = $1 AND org_id = $2 FOR UPDATE`, [a.billId, ctx.orgId]);
    if (!bill) throw notFound("Bill");
    if (bill.supplier_id !== input.supplierId) throw badRequest(`Bill ${bill.number} belongs to a different supplier`);
    if (bill.status === "void") throw badRequest(`Bill ${bill.number} is void`);
    if (bill.currency !== currency) throw badRequest(`Bill ${bill.number} is in ${bill.currency}; pay it in the same currency`);
    const balance = bill.total - bill.amount_paid;
    if (a.amount + discount > balance) throw badRequest(`Allocation exceeds the ${balance} balance on bill ${bill.number}`);

    const settled = a.amount + discount;
    const fullySettled = settled === balance;
    // Carrying value relieved; on the final settlement take exactly what is left to avoid rounding drift.
    const carrying = fullySettled ? bill.total_ngn - bill.ap_relieved_ngn : toNgn(settled, Number(bill.fx_rate));
    const discountCarry = toNgn(discount, Number(bill.fx_rate));
    const paidNgn = toNgn(a.amount, rate);
    const fx = carrying - discountCarry - paidNgn;

    apDebit += carrying;
    discountNgn += discountCarry;
    fxNet += fx;
    paidNgnAllocated += paidNgn;
    numbers.push(bill.number);

    const paid = bill.amount_paid + settled;
    await db.query(`UPDATE bills SET amount_paid = $2, ap_relieved_ngn = ap_relieved_ngn + $3, status = $4 WHERE id = $1`, [
      bill.id, paid, carrying, paid >= bill.total ? "paid" : "partially_paid",
    ]);
    await db.query(
      `INSERT INTO payment_allocations (payment_id, org_id, bill_id, amount, discount, fx_gain_loss_ngn) VALUES ($1,$2,$3,$4,$5,$6)`,
      [payment.id, ctx.orgId, bill.id, settled, discount, fx],
    );
  }
  // Rounding between the per-allocation and whole-payment conversions lands in FX.
  const advance = unallocatedNgn;
  fxNet -= amountNgn - paidNgnAllocated - unallocatedNgn;

  const lines: LineInput[] = [
    { accountId: await accountId(db, ctx.orgId, "ap"), debit: apDebit, contactId: input.supplierId },
    { accountId: await accountId(db, ctx.orgId, "supplier_advances"), debit: advance, contactId: input.supplierId },
    { accountId: cashAcct, credit: amountNgn, contactId: input.supplierId, currency, fxRate: rate, foreignAmount: input.amount },
    { accountId: await accountId(db, ctx.orgId, "discounts_received"), credit: discountNgn, contactId: input.supplierId },
  ];
  if (fxNet > 0) lines.push({ accountId: await accountId(db, ctx.orgId, "fx_gain"), credit: fxNet, description: "Realised FX gain" });
  if (fxNet < 0) lines.push({ accountId: await accountId(db, ctx.orgId, "fx_loss"), debit: -fxNet, description: "Realised FX loss" });

  const entryId = await postEntry(db, ctx.orgId, {
    date: input.date,
    memo: `Payment ${number}${numbers.length ? ` for ${numbers.join(", ")}` : " (supplier advance)"}`,
    sourceType: "payment",
    sourceId: payment.id,
    createdBy: ctx.userId,
    lines,
  });
  await db.query(`UPDATE payments SET journal_entry_id = $2 WHERE id = $1`, [payment.id, entryId]);
  return getPayment(db, ctx.orgId, payment.id);
}

export async function getPayment(db: Db, orgId: string, id: string) {
  const p = await one(db, `SELECT * FROM payments WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!p) throw notFound("Payment");
  p.allocations = await many(
    db,
    `SELECT pa.*, i.number AS invoice_number, b.number AS bill_number FROM payment_allocations pa
       LEFT JOIN invoices i ON i.id = pa.invoice_id LEFT JOIN bills b ON b.id = pa.bill_id
      WHERE pa.payment_id = $1`,
    [id],
  );
  return p;
}
