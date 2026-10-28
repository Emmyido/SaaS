import type { Db } from "../../db/pool.js";
import { one } from "../../db/pool.js";
import { AppError } from "../../lib/errors.js";

type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
  subtype?: string;
  key?: string; // system key used by posting rules
}

/** Default chart of accounts for a Nigerian automotive SME. Codes follow a 1xxx-6xxx layout. */
export const DEFAULT_CHART: SeedAccount[] = [
  // Assets
  { code: "1000", name: "Cash on Hand", type: "asset", subtype: "cash", key: "cash" },
  { code: "1010", name: "Bank Account", type: "asset", subtype: "bank", key: "bank" },
  { code: "1020", name: "POS / Card Settlement", type: "asset", subtype: "bank", key: "pos_clearing" },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable", key: "ar" },
  { code: "1150", name: "Supplier Advances", type: "asset", subtype: "receivable", key: "supplier_advances" },
  { code: "1200", name: "Inventory - Vehicles", type: "asset", subtype: "inventory", key: "inventory_vehicles" },
  { code: "1210", name: "Inventory - Parts & Accessories", type: "asset", subtype: "inventory", key: "inventory_parts" },
  { code: "1220", name: "Goods in Transit", type: "asset", subtype: "inventory", key: "goods_in_transit" },
  { code: "1300", name: "VAT Input (Recoverable)", type: "asset", subtype: "tax", key: "vat_input" },
  { code: "1500", name: "Fleet & Equipment", type: "asset", subtype: "fixed_asset", key: "fixed_assets" },
  { code: "1510", name: "Accumulated Depreciation", type: "asset", subtype: "fixed_asset", key: "accum_depreciation" },
  // Liabilities
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable", key: "ap" },
  { code: "2100", name: "VAT Output (Payable to FIRS)", type: "liability", subtype: "tax", key: "vat_output" },
  { code: "2110", name: "WHT Payable", type: "liability", subtype: "tax", key: "wht_payable" },
  { code: "2200", name: "Customer Deposits", type: "liability", subtype: "deposit", key: "customer_deposits" },
  { code: "2300", name: "Accrued Expenses", type: "liability", subtype: "payable" },
  { code: "2500", name: "Loans & Borrowings", type: "liability", subtype: "loan", key: "loans" },
  // Equity
  { code: "3000", name: "Owner's Capital", type: "equity", key: "capital" },
  { code: "3100", name: "Owner's Drawings", type: "equity", key: "drawings" },
  { code: "3200", name: "Retained Earnings", type: "equity", key: "retained_earnings" },
  { code: "3900", name: "Opening Balance Equity", type: "equity", key: "opening_balance" },
  // Income
  { code: "4000", name: "Vehicle Sales", type: "income", key: "sales_vehicles" },
  { code: "4010", name: "Parts & Accessories Sales", type: "income", key: "sales_parts" },
  { code: "4100", name: "Workshop / Service Income", type: "income", key: "service_income" },
  { code: "4200", name: "Haulage Income", type: "income", key: "haulage_income" },
  { code: "4300", name: "Rental Income", type: "income", key: "rental_income" },
  { code: "4400", name: "Installment Interest Income", type: "income", key: "interest_income" },
  { code: "4500", name: "Discounts Received", type: "income", key: "discounts_received" },
  { code: "4600", name: "Foreign Exchange Gain", type: "income", key: "fx_gain" },
  { code: "4900", name: "Other Income", type: "income", key: "other_income" },
  // Cost of sales
  { code: "5000", name: "Cost of Vehicles Sold", type: "expense", subtype: "cogs", key: "cogs_vehicles" },
  { code: "5010", name: "Cost of Parts Sold", type: "expense", subtype: "cogs", key: "cogs_parts" },
  { code: "5020", name: "Stock Adjustments & Write-offs", type: "expense", subtype: "cogs", key: "stock_adjustments" },
  { code: "5100", name: "Discounts Allowed", type: "expense", key: "discounts_allowed" },
  // Operating expenses
  { code: "6000", name: "Repairs & Reconditioning", type: "expense", key: "exp_repairs" },
  { code: "6010", name: "Clearing & Port Charges", type: "expense", key: "exp_clearing" },
  { code: "6020", name: "Transport & Logistics", type: "expense", key: "exp_transport" },
  { code: "6030", name: "Fuel", type: "expense", key: "exp_fuel" },
  { code: "6040", name: "Tolls, Permits & Levies", type: "expense", key: "exp_tolls" },
  { code: "6100", name: "Salaries & Wages", type: "expense", key: "exp_salaries" },
  { code: "6110", name: "Driver Allowances", type: "expense", key: "exp_driver" },
  { code: "6200", name: "Rent", type: "expense", key: "exp_rent" },
  { code: "6210", name: "Electricity & Diesel", type: "expense", key: "exp_power" },
  { code: "6220", name: "Internet & Phone", type: "expense", key: "exp_comms" },
  { code: "6300", name: "Marketing & Advertising", type: "expense", key: "exp_marketing" },
  { code: "6400", name: "Bank Charges", type: "expense", key: "exp_bank" },
  { code: "6500", name: "Insurance", type: "expense", key: "exp_insurance" },
  { code: "6600", name: "Vehicle Registration & Papers", type: "expense", key: "exp_papers" },
  { code: "6700", name: "Depreciation", type: "expense", key: "exp_depreciation" },
  { code: "6800", name: "Foreign Exchange Loss", type: "expense", key: "fx_loss" },
  { code: "6900", name: "General & Office", type: "expense", key: "exp_office" },
];

/** Expense categories the apps show in a picker, mapped to account system keys. */
export const EXPENSE_CATEGORIES: Record<string, string> = {
  repairs: "exp_repairs",
  clearing: "exp_clearing",
  import_duty: "exp_clearing",
  transport: "exp_transport",
  fuel: "exp_fuel",
  tolls: "exp_tolls",
  salaries: "exp_salaries",
  driver: "exp_driver",
  rent: "exp_rent",
  power: "exp_power",
  comms: "exp_comms",
  marketing: "exp_marketing",
  bank_charges: "exp_bank",
  insurance: "exp_insurance",
  papers: "exp_papers",
  office: "exp_office",
};

export async function seedChart(db: Db, orgId: string): Promise<void> {
  for (const a of DEFAULT_CHART) {
    await db.query(
      `INSERT INTO accounts (org_id, code, name, type, subtype, system_key) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [orgId, a.code, a.name, a.type, a.subtype ?? "other", a.key ?? null],
    );
  }
}

/** Look up a system account id by key, e.g. accountId(db, org, 'ar'). */
export async function accountId(db: Db, orgId: string, key: string): Promise<string> {
  const row = await one(db, `SELECT id FROM accounts WHERE org_id = $1 AND system_key = $2`, [orgId, key]);
  if (!row) throw new AppError(500, "chart_misconfigured", `System account "${key}" missing from chart of accounts`);
  return row.id;
}

/** Validate that an account id belongs to the org (and optionally is a cash/bank account). */
export async function assertAccount(
  db: Db,
  orgId: string,
  id: string,
  opts: { cashOrBank?: boolean } = {},
): Promise<{ id: string; type: AccountType; subtype: string }> {
  const row = await one(db, `SELECT id, type, subtype FROM accounts WHERE org_id = $1 AND id = $2 AND is_active`, [orgId, id]);
  if (!row) throw new AppError(400, "bad_account", "Account not found in this organisation");
  if (opts.cashOrBank && !["cash", "bank"].includes(row.subtype)) {
    throw new AppError(400, "bad_account", "Payments must go through a cash or bank account");
  }
  return row;
}
