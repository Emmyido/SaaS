/**
 * The two GreenRev Business Suite packages. Prices are in kobo.
 * Limits of `null` mean unlimited.
 */
export const FEATURES = [
  "inventory",          // vehicles, parts, photos, stock movements
  "invoicing",          // invoices, receipts, customer payments, discounts
  "expenses",           // expenses with input VAT, per-vehicle costs
  "basic_reports",      // P&L, sales analytics, VAT report, profit per car
  "marketplace",        // publish to greenrevs.com, receive leads
  "ai",                 // VIN scan, photo intake, listing writer, receipt reader
  "payables",           // supplier bills on credit, part-payments, AP aging
  "installments",       // installment plans / hire purchase with interest
  "multi_currency",     // foreign-currency purchases, landed cost, FX gain/loss
  "full_reports",       // balance sheet, cash flow, trial balance, AR/AP aging, general ledger
  "multi_vertical",     // run more than one business line (dealer + workshop + rentals ...)
  "api_access",         // API keys / integrations
] as const;
export type Feature = (typeof FEATURES)[number];

export const VERTICALS = ["dealer", "mechanic", "parts_vendor", "haulage", "rental"] as const;
export type Vertical = (typeof VERTICALS)[number];

export interface Plan {
  id: "starter" | "pro";
  name: string;
  tagline: string;
  priceMonthlyKobo: number;
  priceYearlyKobo: number;
  limits: { users: number | null; vehicles: number | null; parts: number | null; aiCreditsMonthly: number; verticals: number | null };
  features: Feature[];
}

export const PLANS: Record<Plan["id"], Plan> = {
  starter: {
    id: "starter",
    name: "Starter",
    tagline: "Run one car business from your phone",
    priceMonthlyKobo: 15_000_00,
    priceYearlyKobo: 150_000_00,
    limits: { users: 3, vehicles: 50, parts: 1000, aiCreditsMonthly: 50, verticals: 1 },
    features: ["inventory", "invoicing", "expenses", "basic_reports", "marketplace", "ai"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "Full accounting and every business line, for growing operators",
    priceMonthlyKobo: 45_000_00,
    priceYearlyKobo: 450_000_00,
    limits: { users: 25, vehicles: null, parts: null, aiCreditsMonthly: 1000, verticals: null },
    features: [...FEATURES],
  },
};

export function planHas(planId: string, feature: Feature): boolean {
  return (PLANS[planId as Plan["id"]] ?? PLANS.starter).features.includes(feature);
}

export function getPlan(planId: string): Plan {
  return PLANS[planId as Plan["id"]] ?? PLANS.starter;
}
