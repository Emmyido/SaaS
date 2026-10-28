import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { pool, tx, one, many } from "../../db/pool.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { today } from "../../lib/dates.js";
import { ROLES, requireFeature, requireRole } from "../../plugins/context.js";
import { currency, idParams, isoDate, kobo, method, paging, positiveKobo, rateBp, uuid } from "../../lib/schemas.js";
import { EXPENSE_CATEGORIES } from "./chart.js";
import { postEntry, reverseEntry } from "./ledger.js";
import { createInvoice, getInvoice, voidInvoice } from "./invoices.js";
import { applyDeposit, getPayment, payBills, receivePayment, refundDeposit } from "./payments.js";
import { createBill, getBill, voidBill } from "./bills.js";
import { createExpense, deleteExpense } from "./expenses.js";
import { createPlan, dueInstallments, getPlan } from "./installments.js";
import * as reports from "./reports.js";

const dateRange = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const yearStart = () => `${today().slice(0, 4)}-01-01`;
const rangeOf = (q: { from?: string; to?: string }) => ({ from: q.from ?? yearStart(), to: q.to ?? today() });

export const accountingRoutes: FastifyPluginAsyncZod = async (app) => {
  // ---------------------------------------------------------------- chart & journals
  app.get("/accounts", { schema: { tags: ["Accounting"], summary: "Chart of accounts with balances" } }, async (req) =>
    many(
      pool,
      `SELECT a.*, COALESCE(SUM(l.debit - l.credit), 0)::bigint AS balance_dr
         FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id WHERE a.org_id = $1 GROUP BY a.id ORDER BY a.code`,
      [req.ctx.orgId],
    ));

  app.post("/accounts", {
    preValidation: requireRole(ROLES.finance),
    schema: {
      tags: ["Accounting"],
      body: z.object({
        code: z.string().regex(/^\d{3,6}$/),
        name: z.string(),
        type: z.enum(["asset", "liability", "equity", "income", "expense"]),
        subtype: z.enum(["cash", "bank", "receivable", "inventory", "fixed_asset", "payable", "tax", "loan", "deposit", "cogs", "other"]).default("other"),
      }),
    },
  }, async (req, reply) => {
    reply.code(201);
    return one(pool, `INSERT INTO accounts (org_id, code, name, type, subtype) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [
      req.ctx.orgId, req.body.code, req.body.name, req.body.type, req.body.subtype,
    ]);
  });

  app.get("/expense-categories", { schema: { tags: ["Accounting"] } }, async () => Object.keys(EXPENSE_CATEGORIES));

  app.get("/journal-entries", { schema: { tags: ["Accounting"], querystring: paging.merge(dateRange) } }, async (req) => {
    const { from, to } = rangeOf(req.query);
    const entries = await many(
      pool,
      `SELECT e.*, json_agg(json_build_object('account', a.code || ' ' || a.name, 'debit', l.debit, 'credit', l.credit, 'description', l.description) ORDER BY l.debit DESC) AS lines
         FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
        WHERE e.org_id = $1 AND e.entry_date BETWEEN $2 AND $3 GROUP BY e.id ORDER BY e.entry_date DESC, e.entry_no DESC LIMIT $4 OFFSET $5`,
      [req.ctx.orgId, from, to, req.query.limit ?? 50, req.query.offset ?? 0],
    );
    return entries;
  });

  app.post("/journal-entries", {
    preValidation: requireRole(ROLES.finance),
    schema: {
      tags: ["Accounting"],
      summary: "Manual journal (capital, loans, depreciation, corrections)",
      body: z.object({
        date: isoDate,
        memo: z.string().min(3),
        lines: z.array(z.object({ accountId: uuid, debit: kobo.optional(), credit: kobo.optional(), description: z.string().optional(), contactId: uuid.optional() })).min(2),
      }),
    },
  }, async (req, reply) => {
    const id = await tx(async (db) => {
      const ids = [...new Set(req.body.lines.map((l) => l.accountId))];
      const found = await many(db, `SELECT id, system_key FROM accounts WHERE org_id = $1 AND id = ANY($2)`, [req.ctx.orgId, ids]);
      if (found.length !== ids.length) throw badRequest("Unknown account in journal lines");
      // Control accounts are maintained by their sub-ledgers; posting to them by hand would desync AR/AP.
      if (found.some((a) => ["ar", "ap"].includes(a.system_key))) throw badRequest("Use invoices/bills/payments for Accounts Receivable and Payable");
      return postEntry(db, req.ctx.orgId, { ...req.body, sourceType: "manual", createdBy: req.ctx.userId });
    });
    reply.code(201);
    return { id };
  });

  app.post("/journal-entries/:id/reverse", { preValidation: requireRole(ROLES.finance), schema: { tags: ["Accounting"], params: idParams, body: z.object({ date: isoDate.optional() }) } },
    async (req) => {
      const id = await tx(async (db) => {
        const e = await one(db, `SELECT source_type FROM journal_entries WHERE id = $1 AND org_id = $2`, [req.params.id, req.ctx.orgId]);
        if (!e) throw notFound("Journal entry");
        if (e.source_type !== "manual") throw badRequest("Only manual journals can be reversed here; void the source document instead");
        return reverseEntry(db, req.ctx.orgId, req.params.id, req.body.date ?? today(), "Reversal", req.ctx.userId);
      });
      return { id };
    });

  // ---------------------------------------------------------------- sales invoices (AR)
  const invoiceLine = z.object({
    itemId: uuid.optional().describe("Vehicle or part from inventory"),
    description: z.string().optional(),
    quantity: z.number().positive().optional(),
    unitPrice: kobo,
    discount: kobo.optional(),
    vatRateBp: rateBp.optional(),
    revenueAccountId: uuid.optional(),
  });

  app.get("/invoices", {
    schema: { tags: ["Sales"], querystring: paging.merge(dateRange).extend({ status: z.string().optional(), customerId: uuid.optional() }) },
  }, async (req) => {
    const { from, to } = { from: req.query.from ?? "2000-01-01", to: req.query.to ?? "2999-12-31" };
    return many(
      pool,
      `SELECT i.*, c.name AS customer_name, (i.total + i.finance_charges - i.amount_paid - i.amount_credited) AS balance
         FROM invoices i JOIN contacts c ON c.id = i.customer_id
        WHERE i.org_id = $1 AND i.issue_date BETWEEN $2 AND $3 AND ($4::text IS NULL OR i.status = ANY(string_to_array($4, ',')))
          AND ($5::uuid IS NULL OR i.customer_id = $5)
        ORDER BY i.issue_date DESC, i.number DESC LIMIT $6 OFFSET $7`,
      [req.ctx.orgId, from, to, req.query.status ?? null, req.query.customerId ?? null, req.query.limit ?? 50, req.query.offset ?? 0],
    );
  });

  app.post("/invoices", {
    preValidation: [requireFeature("invoicing"), requireRole(ROLES.sales)],
    schema: {
      tags: ["Sales"],
      summary: "Issue an invoice (vehicle sales mark the car sold and unlist it)",
      body: z.object({
        customerId: uuid,
        issueDate: isoDate.default(today),
        dueDate: isoDate.optional(),
        lines: z.array(invoiceLine).min(1),
        discount: kobo.optional().describe("Invoice-level discount"),
        notes: z.string().optional(),
        payment: z.object({ amount: positiveKobo, method, accountId: uuid.optional(), reference: z.string().optional() }).optional()
          .describe("Record money received with the sale (generates a receipt)"),
        installmentPlan: z.object({
          downPayment: kobo, numInstallments: z.number().int().min(1).max(120), frequency: z.enum(["weekly", "monthly"]),
          interestRateBp: rateBp.optional(), startDate: isoDate,
        }).optional(),
      }),
    },
  }, async (req, reply) => {
    const { payment, installmentPlan, ...input } = req.body;
    const result = await tx(async (db) => {
      const inv = await createInvoice(db, req.ctx, input);
      if (installmentPlan) await createPlan(db, req.ctx, inv.id, installmentPlan);
      if (payment) {
        await receivePayment(db, req.ctx, {
          customerId: inv.customer_id, date: inv.issue_date, ...payment, allocations: [{ invoiceId: inv.id, amount: Math.min(payment.amount, inv.balance) }],
        });
      }
      return getInvoice(db, req.ctx.orgId, inv.id);
    });
    reply.code(201);
    return result;
  });

  app.get("/invoices/:id", { schema: { tags: ["Sales"], params: idParams } }, async (req) => getInvoice(pool, req.ctx.orgId, req.params.id));

  app.post("/invoices/:id/void", { preValidation: requireRole(ROLES.finance), schema: { tags: ["Sales"], params: idParams, body: z.object({ date: isoDate.optional() }) } },
    async (req) => tx((db) => voidInvoice(db, req.ctx, req.params.id, req.body.date ?? today())));

  app.post("/invoices/:id/installment-plan", {
    preValidation: requireRole(ROLES.sales),
    schema: {
      tags: ["Installments"],
      summary: "Put an invoice on installments (hire purchase)",
      params: idParams,
      body: z.object({ downPayment: kobo, numInstallments: z.number().int().min(1).max(120), frequency: z.enum(["weekly", "monthly"]), interestRateBp: rateBp.optional(), startDate: isoDate }),
    },
  }, async (req, reply) => {
    reply.code(201);
    return tx((db) => createPlan(db, req.ctx, req.params.id, req.body));
  });

  app.get("/installment-plans/:id", { schema: { tags: ["Installments"], params: idParams } }, async (req) => getPlan(pool, req.ctx.orgId, req.params.id));

  app.get("/installments/due", {
    preValidation: requireFeature("installments"),
    schema: { tags: ["Installments"], summary: "Collections list", querystring: z.object({ asOf: isoDate.optional(), overdueOnly: z.coerce.boolean().default(false) }) },
  }, async (req) => dueInstallments(pool, req.ctx.orgId, req.query.asOf ?? today(), req.query.overdueOnly));

  // ---------------------------------------------------------------- customer payments
  app.post("/payments/receive", {
    preValidation: [requireFeature("invoicing"), requireRole(ROLES.sales)],
    schema: {
      tags: ["Payments"],
      summary: "Record money from a customer (receipt)",
      description: "Omit `allocations` to settle the oldest open invoices automatically; send `[]` to hold the money as a customer deposit.",
      body: z.object({
        customerId: uuid,
        date: isoDate.default(today),
        amount: positiveKobo,
        method,
        accountId: uuid.optional(),
        reference: z.string().optional(),
        allocations: z.array(z.object({ invoiceId: uuid, amount: kobo, discount: kobo.optional().describe("Settlement / early-payment discount") })).optional(),
      }),
    },
  }, async (req, reply) => {
    reply.code(201);
    return tx((db) => receivePayment(db, req.ctx, req.body));
  });

  app.post("/payments/apply-deposit", {
    preValidation: requireRole(ROLES.sales),
    schema: { tags: ["Payments"], body: z.object({ customerId: uuid, invoiceId: uuid, amount: positiveKobo, date: isoDate.default(today) }) },
  }, async (req) => tx((db) => applyDeposit(db, req.ctx, req.body)));

  app.post("/payments/refund-deposit", {
    preValidation: requireRole(ROLES.finance),
    schema: { tags: ["Payments"], body: z.object({ customerId: uuid, amount: positiveKobo, date: isoDate.default(today), method, accountId: uuid.optional(), reference: z.string().optional() }) },
  }, async (req) => tx((db) => refundDeposit(db, req.ctx, req.body)));

  app.get("/payments", {
    schema: { tags: ["Payments"], querystring: paging.merge(dateRange).extend({ direction: z.enum(["in", "out"]).optional(), contactId: uuid.optional() }) },
  }, async (req) =>
    many(
      pool,
      `SELECT p.*, c.name AS contact_name FROM payments p JOIN contacts c ON c.id = p.contact_id
        WHERE p.org_id = $1 AND p.payment_date BETWEEN $2 AND $3 AND ($4::text IS NULL OR p.direction = $4) AND ($5::uuid IS NULL OR p.contact_id = $5)
        ORDER BY p.payment_date DESC, p.number DESC LIMIT $6 OFFSET $7`,
      [req.ctx.orgId, req.query.from ?? "2000-01-01", req.query.to ?? "2999-12-31", req.query.direction ?? null, req.query.contactId ?? null, req.query.limit ?? 50, req.query.offset ?? 0],
    ));

  app.get("/payments/:id", { schema: { tags: ["Payments"], params: idParams } }, async (req) => getPayment(pool, req.ctx.orgId, req.params.id));

  // ---------------------------------------------------------------- bills (AP)
  app.get("/bills", {
    schema: { tags: ["Payables"], querystring: paging.extend({ status: z.string().optional(), supplierId: uuid.optional() }) },
  }, async (req) =>
    many(
      pool,
      `SELECT b.*, c.name AS supplier_name, (b.total - b.amount_paid) AS balance FROM bills b JOIN contacts c ON c.id = b.supplier_id
        WHERE b.org_id = $1 AND ($2::text IS NULL OR b.status = ANY(string_to_array($2, ','))) AND ($3::uuid IS NULL OR b.supplier_id = $3)
        ORDER BY b.bill_date DESC, b.number DESC LIMIT $4 OFFSET $5`,
      [req.ctx.orgId, req.query.status ?? null, req.query.supplierId ?? null, req.query.limit ?? 50, req.query.offset ?? 0],
    ));

  app.post("/bills", {
    preValidation: requireRole(ROLES.finance),
    schema: {
      tags: ["Payables"],
      summary: "Record a supplier bill (foreign currency supported)",
      body: z.object({
        supplierId: uuid,
        supplierRef: z.string().optional(),
        billDate: isoDate.default(today),
        dueDate: isoDate.optional(),
        currency: currency.optional(),
        fxRate: z.number().positive().optional(),
        category: z.string().optional(),
        notes: z.string().optional(),
        attachmentUrl: z.string().url().optional(),
        paidFromAccountId: uuid.optional(),
        lines: z.array(z.object({
          description: z.string(),
          amount: kobo.describe("Minor units of the bill currency, excl. VAT"),
          vatRateBp: rateBp.optional(),
          accountId: uuid.optional(),
          category: z.string().optional(),
          itemId: uuid.optional().describe("Vehicle (capitalised into landed cost) or part (with quantity, received into stock)"),
          quantity: z.number().int().positive().optional(),
          capitalize: z.boolean().optional(),
        })).min(1),
      }),
    },
  }, async (req, reply) => {
    reply.code(201);
    return tx((db) => createBill(db, req.ctx, req.body));
  });

  app.get("/bills/:id", { schema: { tags: ["Payables"], params: idParams } }, async (req) => getBill(pool, req.ctx.orgId, req.params.id));

  app.post("/bills/:id/void", { preValidation: requireRole(ROLES.finance), schema: { tags: ["Payables"], params: idParams, body: z.object({ date: isoDate.optional() }) } },
    async (req) => tx((db) => voidBill(db, req.ctx, req.params.id, req.body.date ?? today())));

  app.post("/payments/pay-bills", {
    preValidation: requireRole(ROLES.finance),
    schema: {
      tags: ["Payables"],
      summary: "Pay suppliers (part-payments, settlement discounts, FX gain/loss)",
      body: z.object({
        supplierId: uuid,
        date: isoDate.default(today),
        currency: currency.optional(),
        fxRate: z.number().positive().optional().describe("Today's rate for foreign bills"),
        amount: positiveKobo.describe("Paid, in payment currency minor units"),
        method,
        accountId: uuid.optional(),
        reference: z.string().optional(),
        allocations: z.array(z.object({ billId: uuid, amount: kobo, discount: kobo.optional() })),
      }),
    },
  }, async (req, reply) => {
    reply.code(201);
    return tx((db) => payBills(db, req.ctx, req.body));
  });

  // ---------------------------------------------------------------- expenses
  app.get("/expenses", {
    schema: { tags: ["Expenses"], querystring: paging.merge(dateRange).extend({ itemId: uuid.optional(), tripId: uuid.optional(), category: z.string().optional() }) },
  }, async (req) => {
    const { from, to } = rangeOf(req.query);
    return many(
      pool,
      `SELECT e.*, i.title AS item_title FROM expenses e LEFT JOIN inventory_items i ON i.id = e.item_id
        WHERE e.org_id = $1 AND e.expense_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR e.item_id = $4) AND ($5::uuid IS NULL OR e.trip_id = $5)
          AND ($6::text IS NULL OR e.category = $6)
        ORDER BY e.expense_date DESC LIMIT $7 OFFSET $8`,
      [req.ctx.orgId, from, to, req.query.itemId ?? null, req.query.tripId ?? null, req.query.category ?? null, req.query.limit ?? 50, req.query.offset ?? 0],
    );
  });

  app.post("/expenses", {
    preValidation: [requireFeature("expenses"), requireRole(ROLES.write)],
    schema: {
      tags: ["Expenses"],
      summary: "Log an expense (per vehicle, trip or job card), with input VAT",
      body: z.object({
        date: isoDate.default(today),
        category: z.string(),
        accountId: uuid.optional(),
        description: z.string(),
        amount: positiveKobo,
        vat: kobo.optional(),
        vatRateBp: rateBp.optional(),
        method: method.optional(),
        paidFromAccountId: uuid.optional(),
        itemId: uuid.optional(),
        capitalize: z.boolean().optional().describe("Add to the vehicle's landed cost (default for unsold vehicles)"),
        tripId: uuid.optional(),
        jobCardId: uuid.optional(),
        supplierId: uuid.optional(),
        receiptUrl: z.string().url().optional(),
      }),
    },
  }, async (req, reply) => {
    reply.code(201);
    return tx((db) => createExpense(db, req.ctx, req.body));
  });

  app.delete("/expenses/:id", { preValidation: requireRole(ROLES.finance), schema: { tags: ["Expenses"], params: idParams } }, async (req) => {
    await tx((db) => deleteExpense(db, req.ctx, req.params.id, today()));
    return { ok: true };
  });

  // ---------------------------------------------------------------- reports
  const rtags = ["Reports"];
  app.get("/reports/profit-and-loss", { preValidation: requireFeature("basic_reports"), schema: { tags: rtags, querystring: dateRange } },
    async (req) => { const r = rangeOf(req.query); return reports.profitAndLoss(pool, req.ctx.orgId, r.from, r.to); });
  app.get("/reports/vat", { preValidation: requireFeature("basic_reports"), schema: { tags: rtags, querystring: dateRange } },
    async (req) => { const r = rangeOf(req.query); return reports.vatReport(pool, req.ctx.orgId, r.from, r.to); });
  app.get("/reports/vehicle-profit", { preValidation: requireFeature("basic_reports"), schema: { tags: rtags, querystring: dateRange } },
    async (req) => { const r = rangeOf(req.query); return reports.vehicleProfit(pool, req.ctx.orgId, r.from, r.to); });
  app.get("/reports/analytics", { preValidation: requireFeature("basic_reports"), schema: { tags: rtags, querystring: dateRange } },
    async (req) => { const r = rangeOf(req.query); return reports.salesAnalytics(pool, req.ctx.orgId, r.from, r.to); });
  app.get("/reports/balance-sheet", { preValidation: requireFeature("full_reports"), schema: { tags: rtags, querystring: z.object({ asOf: isoDate.optional() }) } },
    async (req) => reports.balanceSheet(pool, req.ctx.orgId, req.query.asOf ?? today()));
  app.get("/reports/cash-flow", { preValidation: requireFeature("full_reports"), schema: { tags: rtags, querystring: dateRange } },
    async (req) => { const r = rangeOf(req.query); return reports.cashFlow(pool, req.ctx.orgId, r.from, r.to); });
  app.get("/reports/trial-balance", { preValidation: requireFeature("full_reports"), schema: { tags: rtags, querystring: z.object({ asOf: isoDate.optional() }) } },
    async (req) => reports.trialBalance(pool, req.ctx.orgId, req.query.asOf ?? today()));
  app.get("/reports/ar-aging", { preValidation: requireFeature("full_reports"), schema: { tags: rtags, querystring: z.object({ asOf: isoDate.optional() }) } },
    async (req) => reports.arAging(pool, req.ctx.orgId, req.query.asOf ?? today()));
  app.get("/reports/ap-aging", { preValidation: requireFeature("payables"), schema: { tags: rtags, querystring: z.object({ asOf: isoDate.optional() }) } },
    async (req) => reports.apAging(pool, req.ctx.orgId, req.query.asOf ?? today()));
  app.get("/reports/general-ledger/:id", { preValidation: requireFeature("full_reports"), schema: { tags: rtags, params: idParams, querystring: dateRange } },
    async (req) => { const r = rangeOf(req.query); return reports.generalLedger(pool, req.ctx.orgId, req.params.id, r.from, r.to); });

  app.get("/dashboard", { schema: { tags: rtags, summary: "Home screen numbers" } }, async (req) => {
    const t = today();
    const monthStart = `${t.slice(0, 7)}-01`;
    const [pnl, stock, receivable, payable, leads] = await Promise.all([
      reports.profitAndLoss(pool, req.ctx.orgId, monthStart, t),
      one(pool, `SELECT count(*) FILTER (WHERE kind = 'vehicle' AND status IN ('in_stock', 'in_transit', 'reserved', 'in_repair') AND NOT is_rentable)::int AS vehicles,
                        count(*) FILTER (WHERE marketplace_status = 'listed')::int AS listed,
                        count(*) FILTER (WHERE kind <> 'vehicle' AND quantity <= reorder_level AND status <> 'archived')::int AS low_stock
                   FROM inventory_items WHERE org_id = $1`, [req.ctx.orgId]),
      one(pool, `SELECT COALESCE(SUM(total + finance_charges - amount_paid - amount_credited), 0)::bigint AS total,
                        COALESCE(SUM(total + finance_charges - amount_paid - amount_credited) FILTER (WHERE due_date < $2), 0)::bigint AS overdue
                   FROM invoices WHERE org_id = $1 AND status IN ('issued', 'partially_paid')`, [req.ctx.orgId, t]),
      one(pool, `SELECT COALESCE(SUM(total_ngn - ap_relieved_ngn), 0)::bigint AS total FROM bills WHERE org_id = $1 AND status IN ('open', 'partially_paid')`, [req.ctx.orgId]),
      one(pool, `SELECT count(*)::int AS new FROM marketplace_leads WHERE org_id = $1 AND status = 'new'`, [req.ctx.orgId]),
    ]);
    return {
      month: { from: monthStart, to: t, revenue: pnl.netRevenue, grossProfit: pnl.grossProfit, netProfit: pnl.netProfit, expenses: pnl.totalOperatingExpenses },
      stock,
      receivable,
      payable,
      leads,
    };
  });
};

