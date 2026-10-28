import type { Db } from "../../db/pool.js";
import { one, many } from "../../db/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { allocate, roundMinor } from "../../lib/money.js";
import { addDays, addMonths, today } from "../../lib/dates.js";
import { assertFeature, type OrgContext } from "../../plugins/context.js";
import { accountId } from "./chart.js";
import { postEntry } from "./ledger.js";

export interface PlanInput {
  downPayment: number;
  numInstallments: number;
  frequency: "weekly" | "monthly";
  /** Flat interest over the financed amount for the whole plan, in basis points (1000 = 10%). */
  interestRateBp?: number;
  startDate: string; // due date of the first installment
}

/**
 * Put the remaining balance of an invoice on an installment plan (hire purchase).
 * Interest is flat-rate on the financed amount and is recognised when the plan is agreed:
 *   Dr Accounts Receivable  Cr Installment Interest Income
 */
export async function createPlan(db: Db, ctx: OrgContext, invoiceId: string, input: PlanInput) {
  assertFeature(ctx, "installments");
  const inv = await one(db, `SELECT * FROM invoices WHERE id = $1 AND org_id = $2 FOR UPDATE`, [invoiceId, ctx.orgId]);
  if (!inv) throw notFound("Invoice");
  if (inv.status === "void" || inv.status === "paid") throw conflict(`Invoice ${inv.number} is ${inv.status}`);
  if (await one(db, `SELECT 1 FROM installment_plans WHERE invoice_id = $1 AND status <> 'cancelled'`, [invoiceId])) {
    throw conflict("This invoice already has an installment plan");
  }
  const balance = inv.total + inv.finance_charges - inv.amount_paid - inv.amount_credited;
  if (input.downPayment < 0 || input.downPayment >= balance) {
    throw badRequest(`Down payment must be between 0 and the ${balance} outstanding`);
  }
  const financed = balance - input.downPayment;
  const rateBp = input.interestRateBp ?? 0;
  const interest = roundMinor((financed * rateBp) / 10000);

  const plan = await one(
    db,
    `INSERT INTO installment_plans (org_id, invoice_id, down_payment, financed_amount, interest_rate_bp, interest_total, num_installments, frequency, start_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [ctx.orgId, invoiceId, input.downPayment, financed, rateBp, interest, input.numInstallments, input.frequency, input.startDate],
  );

  const schedule: Array<{ seq: number; due: string; amount: number }> = [];
  if (input.downPayment > 0) schedule.push({ seq: 0, due: inv.issue_date > input.startDate ? input.startDate : inv.issue_date, amount: input.downPayment });
  const parts = allocate(financed + interest, Array(input.numInstallments).fill(1));
  parts.forEach((amount, i) => {
    const due = input.frequency === "monthly" ? addMonths(input.startDate, i) : addDays(input.startDate, 7 * i);
    schedule.push({ seq: i + 1, due, amount });
  });
  for (const s of schedule) {
    await db.query(`INSERT INTO installments (plan_id, org_id, seq, due_date, amount_due) VALUES ($1,$2,$3,$4,$5)`, [
      plan.id, ctx.orgId, s.seq, s.due, s.amount,
    ]);
  }

  if (interest > 0) {
    await db.query(`UPDATE invoices SET finance_charges = finance_charges + $2 WHERE id = $1`, [invoiceId, interest]);
    await postEntry(db, ctx.orgId, {
      date: inv.issue_date > today() ? inv.issue_date : today(),
      memo: `Installment interest on ${inv.number}`,
      sourceType: "installment_plan",
      sourceId: plan.id,
      createdBy: ctx.userId,
      lines: [
        { accountId: await accountId(db, ctx.orgId, "ar"), debit: interest, contactId: inv.customer_id },
        { accountId: await accountId(db, ctx.orgId, "interest_income"), credit: interest, contactId: inv.customer_id },
      ],
    });
  }
  return getPlan(db, ctx.orgId, plan.id);
}

/** Apply money received against an invoice to its schedule, earliest installment first. */
export async function applyToInstallments(db: Db, orgId: string, invoiceId: string, amount: number): Promise<void> {
  const plan = await one(db, `SELECT id FROM installment_plans WHERE invoice_id = $1 AND org_id = $2 AND status = 'active'`, [invoiceId, orgId]);
  if (!plan) return;
  let left = amount;
  const rows = await many(db, `SELECT * FROM installments WHERE plan_id = $1 AND amount_paid < amount_due ORDER BY seq FOR UPDATE`, [plan.id]);
  for (const r of rows) {
    if (left <= 0) break;
    const take = Math.min(left, r.amount_due - r.amount_paid);
    await db.query(`UPDATE installments SET amount_paid = amount_paid + $2 WHERE id = $1`, [r.id, take]);
    left -= take;
  }
  const open = await one(db, `SELECT count(*)::int AS n FROM installments WHERE plan_id = $1 AND amount_paid < amount_due`, [plan.id]);
  if (open.n === 0) await db.query(`UPDATE installment_plans SET status = 'completed' WHERE id = $1`, [plan.id]);
}

function installmentStatus(r: { amount_due: number; amount_paid: number; due_date: string }, asOf: string) {
  if (r.amount_paid >= r.amount_due) return "paid";
  if (r.due_date < asOf) return "overdue";
  return r.amount_paid > 0 ? "partial" : "pending";
}

export async function getPlan(db: Db, orgId: string, planId: string) {
  const plan = await one(
    db,
    `SELECT p.*, i.number AS invoice_number, i.customer_id, c.name AS customer_name, c.phone AS customer_phone
       FROM installment_plans p JOIN invoices i ON i.id = p.invoice_id JOIN contacts c ON c.id = i.customer_id
      WHERE p.id = $1 AND p.org_id = $2`,
    [planId, orgId],
  );
  if (!plan) throw notFound("Installment plan");
  const asOf = today();
  plan.schedule = (await many(db, `SELECT * FROM installments WHERE plan_id = $1 ORDER BY seq`, [planId])).map((r) => ({
    ...r,
    balance: r.amount_due - r.amount_paid,
    status: installmentStatus(r, asOf),
  }));
  plan.total_payable = plan.down_payment + plan.financed_amount + plan.interest_total;
  plan.outstanding = plan.schedule.reduce((s: number, r: any) => s + r.balance, 0);
  return plan;
}

/** Collections list: installments due (or overdue) on or before a date, with customer contact details. */
export async function dueInstallments(db: Db, orgId: string, asOf: string, onlyOverdue: boolean) {
  const rows = await many(
    db,
    `SELECT s.*, p.invoice_id, i.number AS invoice_number, c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone
       FROM installments s JOIN installment_plans p ON p.id = s.plan_id
       JOIN invoices i ON i.id = p.invoice_id JOIN contacts c ON c.id = i.customer_id
      WHERE s.org_id = $1 AND p.status = 'active' AND s.amount_paid < s.amount_due AND s.due_date ${onlyOverdue ? "<" : "<="} $2
      ORDER BY s.due_date`,
    [orgId, asOf],
  );
  return rows.map((r) => ({ ...r, balance: r.amount_due - r.amount_paid, status: installmentStatus(r, asOf) }));
}
