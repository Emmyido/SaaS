import type { Db } from "../../db/pool.js";
import { many, one } from "../../db/pool.js";
import { daysBetween } from "../../lib/dates.js";
import { accountId } from "./chart.js";

interface AccountBalance {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  subtype: string;
  system_key: string | null;
  debit: number;
  credit: number;
}

async function balances(db: Db, orgId: string, from: string | null, to: string): Promise<AccountBalance[]> {
  return many<AccountBalance>(
    db,
    `SELECT a.id, a.code, a.name, a.type, a.subtype, a.system_key,
            COALESCE(SUM(l.debit), 0)::bigint AS debit, COALESCE(SUM(l.credit), 0)::bigint AS credit
       FROM accounts a
       LEFT JOIN journal_lines l ON l.account_id = a.id
       LEFT JOIN journal_entries e ON e.id = l.entry_id
      WHERE a.org_id = $1 AND (l.id IS NULL OR (e.entry_date <= $3 AND ($2::date IS NULL OR e.entry_date >= $2)))
      GROUP BY a.id ORDER BY a.code`,
    [orgId, from, to],
  );
}

/** Natural-sign balance: assets/expenses are debit-positive, the rest credit-positive. */
function natural(a: AccountBalance): number {
  return a.type === "asset" || a.type === "expense" ? a.debit - a.credit : a.credit - a.debit;
}

const row = (a: AccountBalance) => ({ accountId: a.id, code: a.code, name: a.name, amount: natural(a) });
const nonZero = (a: AccountBalance) => a.debit !== 0 || a.credit !== 0;
const sum = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0);

export async function trialBalance(db: Db, orgId: string, asOf: string) {
  const rows = (await balances(db, orgId, null, asOf)).filter(nonZero).map((a) => {
    const net = a.debit - a.credit;
    return { accountId: a.id, code: a.code, name: a.name, type: a.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
  });
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { asOf, rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

export async function profitAndLoss(db: Db, orgId: string, from: string, to: string) {
  const all = (await balances(db, orgId, from, to)).filter(nonZero);
  const revenue = all.filter((a) => a.type === "income" && !["fx_gain", "discounts_received", "interest_income", "other_income"].includes(a.system_key ?? "")).map(row);
  const otherIncome = all.filter((a) => a.type === "income" && ["fx_gain", "discounts_received", "interest_income", "other_income"].includes(a.system_key ?? "")).map(row);
  const discountsAllowed = all.filter((a) => a.system_key === "discounts_allowed").map(row);
  const costOfSales = all.filter((a) => a.type === "expense" && a.subtype === "cogs").map(row);
  const operatingExpenses = all.filter((a) => a.type === "expense" && a.subtype !== "cogs" && a.system_key !== "discounts_allowed").map(row);

  const totalRevenue = sum(revenue);
  const netRevenue = totalRevenue - sum(discountsAllowed);
  const grossProfit = netRevenue - sum(costOfSales);
  const operatingProfit = grossProfit - sum(operatingExpenses);
  const netProfit = operatingProfit + sum(otherIncome);
  return {
    from,
    to,
    revenue,
    totalRevenue,
    discountsAllowed: sum(discountsAllowed),
    netRevenue,
    costOfSales,
    totalCostOfSales: sum(costOfSales),
    grossProfit,
    grossMarginPct: netRevenue ? Math.round((grossProfit / netRevenue) * 10000) / 100 : 0,
    operatingExpenses,
    totalOperatingExpenses: sum(operatingExpenses),
    operatingProfit,
    otherIncome,
    totalOtherIncome: sum(otherIncome),
    netProfit,
  };
}

/** Statement of financial position. Current-year earnings are shown inside equity (no closing entries needed). */
export async function balanceSheet(db: Db, orgId: string, asOf: string) {
  const all = (await balances(db, orgId, null, asOf)).filter(nonZero);
  const assets = all.filter((a) => a.type === "asset");
  const current = assets.filter((a) => a.subtype !== "fixed_asset").map(row);
  const nonCurrent = assets.filter((a) => a.subtype === "fixed_asset").map(row);
  const liabilities = all.filter((a) => a.type === "liability");
  const currentLiabilities = liabilities.filter((a) => a.subtype !== "loan").map(row);
  const longTermLiabilities = liabilities.filter((a) => a.subtype === "loan").map(row);
  const equity = all.filter((a) => a.type === "equity").map(row);
  const earnings = all.filter((a) => a.type === "income").reduce((s, a) => s + natural(a), 0) -
    all.filter((a) => a.type === "expense").reduce((s, a) => s + natural(a), 0);
  equity.push({ accountId: "", code: "", name: "Retained earnings (unclosed profit to date)", amount: earnings });

  const totalAssets = sum(current) + sum(nonCurrent);
  const totalLiabilities = sum(currentLiabilities) + sum(longTermLiabilities);
  const totalEquity = sum(equity);
  return {
    asOf,
    assets: { current, nonCurrent, total: totalAssets },
    liabilities: { current: currentLiabilities, longTerm: longTermLiabilities, total: totalLiabilities },
    equity: { lines: equity, total: totalEquity },
    totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

/**
 * Direct-method cash flow. Each journal entry that moves cash is split by its non-cash counterpart lines,
 * so the categories always add up exactly to the change in cash.
 */
export async function cashFlow(db: Db, orgId: string, from: string, to: string) {
  const lines = await many(
    db,
    `WITH cash_entries AS (
       SELECT DISTINCT l.entry_id FROM journal_lines l JOIN accounts a ON a.id = l.account_id
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.org_id = $1 AND a.subtype IN ('cash', 'bank') AND e.entry_date BETWEEN $2 AND $3)
     SELECT a.type, a.subtype, a.system_key, SUM(l.credit - l.debit)::bigint AS cash_effect
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id IN (SELECT entry_id FROM cash_entries) AND a.subtype NOT IN ('cash', 'bank')
      GROUP BY a.type, a.subtype, a.system_key`,
    [orgId, from, to],
  );
  const buckets: Record<string, Record<string, number>> = { operating: {}, investing: {}, financing: {} };
  const add = (section: string, label: string, v: number) => (buckets[section][label] = (buckets[section][label] ?? 0) + v);
  for (const l of lines) {
    const v = Number(l.cash_effect);
    if (l.subtype === "fixed_asset") add("investing", "Purchase / sale of fleet & equipment", v);
    else if (l.subtype === "loan") add("financing", "Loans received / repaid", v);
    else if (l.type === "equity") add("financing", l.system_key === "drawings" ? "Owner drawings" : "Owner capital", v);
    else if (["receivable", "deposit"].includes(l.subtype) && l.system_key !== "supplier_advances") add("operating", "Cash received from customers", v);
    else if (l.type === "income") add("operating", "Cash sales & other income", v);
    else if (l.subtype === "tax") add("operating", "VAT & taxes", v);
    else if (["payable", "inventory"].includes(l.subtype) || l.system_key === "supplier_advances") add("operating", "Cash paid to suppliers", v);
    else add("operating", "Operating expenses paid", v);
  }
  const toRows = (o: Record<string, number>) => Object.entries(o).map(([label, amount]) => ({ label, amount }));
  const operating = toRows(buckets.operating);
  const investing = toRows(buckets.investing);
  const financing = toRows(buckets.financing);

  const cashAt = async (date: string, inclusive: boolean) => {
    const r = await one(
      db,
      `SELECT COALESCE(SUM(l.debit - l.credit), 0)::bigint AS bal FROM journal_lines l JOIN accounts a ON a.id = l.account_id
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.org_id = $1 AND a.subtype IN ('cash', 'bank') AND e.entry_date ${inclusive ? "<=" : "<"} $2`,
      [orgId, date],
    );
    return Number(r.bal);
  };
  const openingCash = await cashAt(from, false);
  const closingCash = await cashAt(to, true);
  const netChange = sum(operating) + sum(investing) + sum(financing);
  return {
    from,
    to,
    openingCash,
    operating: { lines: operating, total: sum(operating) },
    investing: { lines: investing, total: sum(investing) },
    financing: { lines: financing, total: sum(financing) },
    netChange,
    closingCash,
    reconciles: openingCash + netChange === closingCash,
  };
}

function bucket(daysOverdue: number): "current" | "1_30" | "31_60" | "61_90" | "over_90" {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "1_30";
  if (daysOverdue <= 60) return "31_60";
  if (daysOverdue <= 90) return "61_90";
  return "over_90";
}

async function aging(db: Db, orgId: string, asOf: string, kind: "ar" | "ap") {
  const docs = kind === "ar"
    ? await many(
        db,
        `SELECT i.id, i.number, i.issue_date AS date, i.due_date, c.id AS contact_id, c.name AS contact_name, c.phone,
                (i.total + i.finance_charges - i.amount_paid - i.amount_credited) AS balance
           FROM invoices i JOIN contacts c ON c.id = i.customer_id
          WHERE i.org_id = $1 AND i.status IN ('issued', 'partially_paid') AND i.issue_date <= $2`,
        [orgId, asOf],
      )
    : await many(
        db,
        // AP is reported in NGN at carrying value so foreign bills are comparable.
        `SELECT b.id, b.number, b.supplier_ref, b.bill_date AS date, b.due_date, c.id AS contact_id, c.name AS contact_name, c.phone,
                b.currency, (b.total - b.amount_paid) AS balance_foreign, (b.total_ngn - b.ap_relieved_ngn) AS balance
           FROM bills b JOIN contacts c ON c.id = b.supplier_id
          WHERE b.org_id = $1 AND b.status IN ('open', 'partially_paid') AND b.bill_date <= $2`,
        [orgId, asOf],
      );
  const totals = { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0, total: 0 };
  const byContact = new Map<string, any>();
  const documents = docs.map((d) => {
    const overdue = daysBetween(d.due_date, asOf);
    const b = bucket(overdue);
    totals[b] += d.balance;
    totals.total += d.balance;
    const c = byContact.get(d.contact_id) ?? { contactId: d.contact_id, name: d.contact_name, phone: d.phone, current: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0, total: 0 };
    c[b] += d.balance;
    c.total += d.balance;
    byContact.set(d.contact_id, c);
    return { ...d, daysOverdue: Math.max(0, overdue), bucket: b };
  });
  return { asOf, totals, contacts: [...byContact.values()].sort((a, b) => b.total - a.total), documents };
}

export const arAging = (db: Db, orgId: string, asOf: string) => aging(db, orgId, asOf, "ar");
export const apAging = (db: Db, orgId: string, asOf: string) => aging(db, orgId, asOf, "ap");

/** VAT return helper: output VAT charged vs input VAT recoverable for the period (for FIRS filing). */
export async function vatReport(db: Db, orgId: string, from: string, to: string) {
  const [outAcct, inAcct] = await Promise.all([accountId(db, orgId, "vat_output"), accountId(db, orgId, "vat_input")]);
  const r = await one(
    db,
    `SELECT COALESCE(SUM(CASE WHEN l.account_id = $4 THEN l.credit - l.debit END), 0)::bigint AS output_vat,
            COALESCE(SUM(CASE WHEN l.account_id = $5 THEN l.debit - l.credit END), 0)::bigint AS input_vat
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.org_id = $1 AND e.entry_date BETWEEN $2 AND $3`,
    [orgId, from, to, outAcct, inAcct],
  );
  const sales = await one(
    db,
    `SELECT COALESCE(SUM(l.gross - l.discount), 0)::bigint AS taxable, COALESCE(SUM(CASE WHEN l.vat_rate_bp = 0 THEN l.gross - l.discount END), 0)::bigint AS zero_rated
       FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE i.org_id = $1 AND i.status <> 'void' AND i.issue_date BETWEEN $2 AND $3`,
    [orgId, from, to],
  );
  const outputVat = Number(r.output_vat);
  const inputVat = Number(r.input_vat);
  return {
    from,
    to,
    salesExclVat: Number(sales.taxable),
    zeroRatedOrExemptSales: Number(sales.zero_rated),
    outputVat,
    inputVat,
    netVatPayable: outputVat - inputVat,
    position: outputVat - inputVat >= 0 ? "payable" : "refundable",
  };
}

/** Profit per vehicle sold: net sale price vs landed cost, with days in stock. */
export async function vehicleProfit(db: Db, orgId: string, from: string, to: string) {
  const rows = await many(
    db,
    `SELECT it.id, it.title, it.make, it.model, it.year, it.vin, it.purchased_at, it.created_at::date AS stocked_on,
            i.number AS invoice_number, i.issue_date AS sold_on, c.name AS customer_name,
            (l.gross - l.discount) AS net_sale, l.cost_ngn AS landed_cost
       FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
       JOIN inventory_items it ON it.id = l.item_id JOIN contacts c ON c.id = i.customer_id
      WHERE i.org_id = $1 AND it.kind = 'vehicle' AND i.status <> 'void' AND i.issue_date BETWEEN $2 AND $3
      ORDER BY i.issue_date`,
    [orgId, from, to],
  );
  const vehicles = rows.map((r) => {
    const profit = r.net_sale - r.landed_cost;
    return {
      ...r,
      profit,
      marginPct: r.net_sale ? Math.round((profit / r.net_sale) * 10000) / 100 : 0,
      daysInStock: daysBetween(r.purchased_at ?? r.stocked_on, r.sold_on),
    };
  });
  const totalSales = vehicles.reduce((s, v) => s + v.net_sale, 0);
  const totalProfit = vehicles.reduce((s, v) => s + v.profit, 0);
  return {
    from,
    to,
    vehicles,
    count: vehicles.length,
    totalSales,
    totalCost: vehicles.reduce((s, v) => s + v.landed_cost, 0),
    totalProfit,
    averageProfit: vehicles.length ? Math.round(totalProfit / vehicles.length) : 0,
    averageDaysInStock: vehicles.length ? Math.round(vehicles.reduce((s, v) => s + v.daysInStock, 0) / vehicles.length) : 0,
  };
}

/** Dashboard analytics: monthly sales and profit, top models, stock value and slow movers. */
export async function salesAnalytics(db: Db, orgId: string, from: string, to: string) {
  const monthly = await many(
    db,
    `SELECT to_char(e.entry_date, 'YYYY-MM') AS month,
            COALESCE(SUM(CASE WHEN a.type = 'income' THEN l.credit - l.debit END), 0)::bigint AS income,
            COALESCE(SUM(CASE WHEN a.type = 'expense' THEN l.debit - l.credit END), 0)::bigint AS expenses
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE l.org_id = $1 AND e.entry_date BETWEEN $2 AND $3 AND a.type IN ('income', 'expense')
      GROUP BY 1 ORDER BY 1`,
    [orgId, from, to],
  );
  const topModels = await many(
    db,
    `SELECT it.make, it.model, count(*)::int AS units, SUM(l.gross - l.discount)::bigint AS revenue,
            SUM(l.gross - l.discount - l.cost_ngn)::bigint AS profit
       FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id JOIN inventory_items it ON it.id = l.item_id
      WHERE i.org_id = $1 AND it.kind = 'vehicle' AND i.status <> 'void' AND i.issue_date BETWEEN $2 AND $3
      GROUP BY it.make, it.model ORDER BY units DESC, revenue DESC LIMIT 10`,
    [orgId, from, to],
  );
  const topParts = await many(
    db,
    `SELECT it.id, it.title, SUM(l.quantity)::numeric AS units, SUM(l.gross - l.discount)::bigint AS revenue
       FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id JOIN inventory_items it ON it.id = l.item_id
      WHERE i.org_id = $1 AND it.kind <> 'vehicle' AND i.status <> 'void' AND i.issue_date BETWEEN $2 AND $3
      GROUP BY it.id ORDER BY revenue DESC LIMIT 10`,
    [orgId, from, to],
  );
  const stock = await one(
    db,
    `SELECT count(*) FILTER (WHERE kind = 'vehicle' AND status IN ('in_stock', 'in_transit', 'reserved', 'in_repair') AND NOT is_rentable)::int AS vehicles_in_stock,
            COALESCE(SUM(landed_cost_ngn) FILTER (WHERE kind = 'vehicle' AND status IN ('in_stock', 'in_transit', 'reserved', 'in_repair') AND NOT is_rentable), 0)::bigint AS vehicle_stock_value,
            COALESCE(SUM(asking_price_ngn) FILTER (WHERE kind = 'vehicle' AND status IN ('in_stock', 'in_transit', 'reserved', 'in_repair') AND NOT is_rentable), 0)::bigint AS vehicle_asking_value,
            COALESCE(SUM(quantity * unit_cost_ngn) FILTER (WHERE kind <> 'vehicle'), 0)::bigint AS parts_stock_value,
            count(*) FILTER (WHERE kind <> 'vehicle' AND quantity <= reorder_level AND status <> 'archived')::int AS parts_to_reorder
       FROM inventory_items WHERE org_id = $1`,
    [orgId],
  );
  const slowMovers = await many(
    db,
    `SELECT id, title, make, model, year, landed_cost_ngn, asking_price_ngn,
            (current_date - COALESCE(purchased_at, created_at::date))::int AS days_in_stock
       FROM inventory_items
      WHERE org_id = $1 AND kind = 'vehicle' AND NOT is_rentable AND status IN ('in_stock', 'reserved', 'in_repair')
      ORDER BY days_in_stock DESC LIMIT 10`,
    [orgId],
  );
  return {
    from,
    to,
    monthly: monthly.map((m) => ({ ...m, profit: m.income - m.expenses })),
    topModels,
    topParts,
    stock,
    slowMovers,
  };
}

export async function generalLedger(db: Db, orgId: string, acctId: string, from: string, to: string) {
  const opening = await one(
    db,
    `SELECT COALESCE(SUM(l.debit - l.credit), 0)::bigint AS bal FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.org_id = $1 AND l.account_id = $2 AND e.entry_date < $3`,
    [orgId, acctId, from],
  );
  const rows = await many(
    db,
    `SELECT e.entry_no, e.entry_date, e.memo, e.source_type, e.source_id, l.debit, l.credit, l.description, c.name AS contact_name
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id LEFT JOIN contacts c ON c.id = l.contact_id
      WHERE l.org_id = $1 AND l.account_id = $2 AND e.entry_date BETWEEN $3 AND $4
      ORDER BY e.entry_date, e.entry_no`,
    [orgId, acctId, from, to],
  );
  let running = Number(opening.bal);
  const lines = rows.map((r) => {
    running += r.debit - r.credit;
    return { ...r, balance: running };
  });
  return { accountId: acctId, from, to, openingBalance: Number(opening.bal), lines, closingBalance: running };
}

/** Customer or supplier statement from the ledger (AR/AP + deposits). */
export async function contactStatement(db: Db, orgId: string, contactId: string, from: string, to: string) {
  const keys = ["ar", "ap", "customer_deposits", "supplier_advances"];
  const accts = await many(db, `SELECT id, system_key FROM accounts WHERE org_id = $1 AND system_key = ANY($2)`, [orgId, keys]);
  const ids = accts.map((a) => a.id);
  const opening = await one(
    db,
    `SELECT COALESCE(SUM(l.debit - l.credit), 0)::bigint AS bal FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.org_id = $1 AND l.contact_id = $2 AND l.account_id = ANY($3) AND e.entry_date < $4`,
    [orgId, contactId, ids, from],
  );
  const rows = await many(
    db,
    `SELECT e.entry_date, e.memo, e.source_type, e.source_id, SUM(l.debit)::bigint AS debit, SUM(l.credit)::bigint AS credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.org_id = $1 AND l.contact_id = $2 AND l.account_id = ANY($3) AND e.entry_date BETWEEN $4 AND $5
      GROUP BY e.id ORDER BY e.entry_date, e.entry_no`,
    [orgId, contactId, ids, from, to],
  );
  let running = Number(opening.bal);
  const lines = rows.map((r) => {
    running += r.debit - r.credit;
    return { ...r, balance: running };
  });
  // Positive balance = they owe us; negative = we owe them / hold their money.
  return { contactId, from, to, openingBalance: Number(opening.bal), lines, closingBalance: running };
}
