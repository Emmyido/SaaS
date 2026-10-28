import { beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { LogMarketplaceAdapter, setMarketplaceAdapter } from "../src/modules/marketplace/adapter.js";
import { processOutbox } from "../src/modules/marketplace/worker.js";
import { accountBalance, N, signUp, useApp, type Session } from "./helpers.js";

/**
 * A Lagos dealer imports a 2019 Lexus RX 350 from the US, pays the exporter in two
 * instalments at different exchange rates, reconditions it, lists it on greenrevs.com,
 * and sells it on a hire-purchase plan. Every number below is checked against the ledger.
 */
describe("dealer: import → landed cost → marketplace → installment sale", () => {
  const t = useApp();
  const market = new LogMarketplaceAdapter();
  let s: Session;
  let exporter: any, clearingAgent: any, buyer: any, car: any, invoice: any;

  beforeAll(async () => {
    setMarketplaceAdapter(market);
    s = await signUp(t.app, { plan: "pro", verticals: ["dealer"] });
    await s.call("PUT", "/fx-rates", { rates: [{ currency: "USD", rate: 1500, date: "2026-03-01" }] });
    exporter = await s.call("POST", "/contacts", { kind: "supplier", name: "Houston Auto Export LLC", country: "US" });
    clearingAgent = await s.call("POST", "/contacts", { kind: "supplier", name: "Apapa Clearing Ltd" });
    buyer = await s.call("POST", "/contacts", { kind: "customer", name: "Chinedu Eze", phone: "+2348030000000" });
  });

  it("records the purchase in USD and builds a naira landed cost", async () => {
    car = await s.call("POST", "/inventory/vehicles", {
      vin: "2T2BZMCA5KC123456",
      make: "Lexus",
      model: "RX 350",
      year: 2019,
      color: "Black",
      mileageKm: 64000,
      condition: "foreign_used",
      status: "in_transit",
      purchasedAt: "2026-03-01",
      askingPriceNgn: N(26_000_000),
      purchase: {
        supplierId: exporter.id,
        currency: "USD",
        amount: 10_000_00, // $10,000.00 at the saved ₦1,500 rate
        supplierRef: "HAE-7781",
      },
    });
    expect(car.landed_cost_ngn).toBe(N(15_000_000));
    expect(car.purchase_fx_rate).toBe(1500);

    // Duty and clearing billed by the agent in naira, capitalised to the car.
    await s.call("POST", "/bills", {
      supplierId: clearingAgent.id,
      billDate: "2026-03-20",
      lines: [
        { description: "Import duty & levies", amount: N(3_000_000), itemId: car.id },
        { description: "Terminal & clearing", amount: N(500_000), itemId: car.id },
      ],
    });
    // Reconditioning paid in cash, added to the car's cost by default.
    await s.call("POST", "/expenses", { date: "2026-03-25", category: "repairs", description: "Body work & detailing", amount: N(200_000), itemId: car.id });

    const after = await s.call("GET", `/inventory/${car.id}`);
    expect(after.landed_cost_ngn).toBe(N(18_700_000));
    expect(after.costs).toHaveLength(4);
    expect(after.margin_at_asking).toBe(N(7_300_000));
    expect(await accountBalance(s.orgId, "inventory_vehicles")).toBe(N(18_700_000));
  });

  it("realises FX loss and gain when paying the USD bill at different rates", async () => {
    const [bill] = await s.call("GET", `/bills?supplierId=${exporter.id}`);
    expect(bill.total_ngn).toBe(N(15_000_000));

    // $4,000 at ₦1,600: carrying ₦6.0m, paid ₦6.4m -> ₦400k loss
    await s.call("POST", "/payments/pay-bills", {
      supplierId: exporter.id, date: "2026-03-10", currency: "USD", fxRate: 1600, amount: 4_000_00, method: "transfer",
      allocations: [{ billId: bill.id, amount: 4_000_00 }],
    });
    // $6,000 at ₦1,450: carrying ₦9.0m, paid ₦8.7m -> ₦300k gain
    await s.call("POST", "/payments/pay-bills", {
      supplierId: exporter.id, date: "2026-04-02", currency: "USD", fxRate: 1450, amount: 6_000_00, method: "transfer",
      allocations: [{ billId: bill.id, amount: 6_000_00 }],
    });

    const paid = await s.call("GET", `/bills/${bill.id}`);
    expect(paid.status).toBe("paid");
    expect(await accountBalance(s.orgId, "fx_loss")).toBe(N(400_000));
    expect(await accountBalance(s.orgId, "fx_gain")).toBe(-N(300_000));
    // Only the agent's naira bill is still owed.
    expect(await accountBalance(s.orgId, "ap")).toBe(-N(3_500_000));
  });

  it("publishes in-stock cars to the GreenRev marketplace and unlists them when sold", async () => {
    await s.call("PATCH", `/inventory/${car.id}`, { status: "in_stock" });
    await s.call("POST", `/inventory/${car.id}/photos/urls`, { urls: ["https://cdn.greenrevs.com/demo/rx350-front.jpg"] });
    await processOutbox();

    const listed = await s.call("GET", `/inventory/${car.id}`);
    expect(listed.marketplace_status).toBe("listed");
    expect(listed.marketplace_listing_id).toBe(`local-${car.id}`);
    const pushed = market.calls.filter((c) => c.op === "upsert").at(-1)!.listing!;
    expect(pushed).toMatchObject({ type: "vehicle", priceNgn: N(26_000_000), photos: ["https://cdn.greenrevs.com/demo/rx350-front.jpg"] });
    expect(pushed.vehicle).toMatchObject({ make: "Lexus", model: "RX 350", year: 2019, vinLast6: "123456" });
    // Cost data never leaves the business.
    expect(JSON.stringify(pushed)).not.toContain("18700000");
  });

  it("sells the car with a discount on a 4-month installment plan with 10% interest", async () => {
    invoice = await s.call("POST", "/invoices", {
      customerId: buyer.id,
      issueDate: "2026-04-10",
      lines: [{ itemId: car.id, unitPrice: N(25_000_000), discount: N(500_000), vatRateBp: 0 }],
      installmentPlan: { downPayment: N(4_500_000), numInstallments: 4, frequency: "monthly", interestRateBp: 1000, startDate: "2026-05-10" },
    });
    expect(invoice.total).toBe(N(24_500_000));
    expect(invoice.finance_charges).toBe(N(2_000_000)); // 10% of ₦20m financed
    expect(invoice.balance).toBe(N(26_500_000));

    const plan = await s.call("GET", `/installment-plans/${invoice.installment_plan_id}`);
    expect(plan.schedule.map((r: any) => r.amount_due)).toEqual([N(4_500_000), N(5_500_000), N(5_500_000), N(5_500_000), N(5_500_000)]);
    expect(plan.schedule.map((r: any) => r.due_date)).toEqual(["2026-04-10", "2026-05-10", "2026-06-10", "2026-07-10", "2026-08-10"]);

    const sold = await s.call("GET", `/inventory/${car.id}`);
    expect(sold.status).toBe("sold");
    await processOutbox();
    expect((await s.call("GET", `/inventory/${car.id}`)).marketplace_status).toBe("unlisted");
    expect(market.calls.at(-1)).toMatchObject({ op: "unpublish", listingId: `local-${car.id}` });

    // Cannot sell the same car twice.
    const again = await s.raw("POST", "/invoices", { customerId: buyer.id, lines: [{ itemId: car.id, unitPrice: N(1) }] });
    expect(again.status).toBe(409);
  });

  it("applies payments to the schedule in order and tracks overdue installments", async () => {
    await s.call("POST", "/payments/receive", { customerId: buyer.id, date: "2026-04-10", amount: N(4_500_000), method: "transfer" });
    await s.call("POST", "/payments/receive", { customerId: buyer.id, date: "2026-05-12", amount: N(3_000_000), method: "cash" });

    const plan = await s.call("GET", `/installment-plans/${invoice.installment_plan_id}`);
    expect(plan.schedule.map((r: any) => r.amount_paid)).toEqual([N(4_500_000), N(3_000_000), 0, 0, 0]);
    expect(plan.outstanding).toBe(N(19_000_000));

    const overdue = await s.call("GET", "/installments/due?asOf=2026-06-15&overdueOnly=true");
    expect(overdue.map((r: any) => [r.seq, r.balance])).toEqual([[1, N(2_500_000)], [2, N(5_500_000)]]);
    expect(overdue[0].customer_phone).toBe("+2348030000000");
  });

  it("produces statements that tie out", async () => {
    const pnl = await s.call("GET", "/reports/profit-and-loss?from=2026-01-01&to=2026-12-31");
    expect(pnl.totalRevenue).toBe(N(25_000_000));
    expect(pnl.discountsAllowed).toBe(N(500_000));
    expect(pnl.totalCostOfSales).toBe(N(18_700_000));
    expect(pnl.grossProfit).toBe(N(5_800_000));
    expect(pnl.totalOperatingExpenses).toBe(N(400_000)); // FX loss
    expect(pnl.totalOtherIncome).toBe(N(2_300_000));     // interest ₦2m + FX gain ₦300k
    expect(pnl.netProfit).toBe(N(7_700_000));

    const bs = await s.call("GET", "/reports/balance-sheet?asOf=2026-12-31");
    expect(bs.balanced).toBe(true);
    const tb = await s.call("GET", "/reports/trial-balance?asOf=2026-12-31");
    expect(tb.balanced).toBe(true);

    const cf = await s.call("GET", "/reports/cash-flow?from=2026-01-01&to=2026-12-31");
    expect(cf.reconciles).toBe(true);
    expect(cf.closingCash).toBe(N(4_500_000 + 3_000_000 - 200_000 - 6_400_000 - 8_700_000));

    const profit = await s.call("GET", "/reports/vehicle-profit?from=2026-01-01&to=2026-12-31");
    expect(profit.vehicles[0]).toMatchObject({ net_sale: N(24_500_000), landed_cost: N(18_700_000), profit: N(5_800_000), daysInStock: 40 });

    const ar = await s.call("GET", "/reports/ar-aging?asOf=2026-06-15");
    expect(ar.totals.total).toBe(N(19_000_000));

    const ap = await s.call("GET", "/reports/ap-aging?asOf=2026-06-15");
    expect(ap.totals.total).toBe(N(3_500_000));

    // The sold car has left inventory entirely.
    expect(await accountBalance(s.orgId, "inventory_vehicles")).toBe(0);

    // The statement for the buyer agrees with AR.
    const st = await s.call("GET", `/contacts/${buyer.id}/statement`);
    expect(st.closingBalance).toBe(N(19_000_000));
  });

  it("enforces balanced journals at the database level", async () => {
    const entry = await pool.query(`SELECT id, org_id FROM journal_entries WHERE org_id = $1 LIMIT 1`, [s.orgId]);
    const line = await pool.query(`SELECT id FROM journal_lines WHERE entry_id = $1 AND debit > 0 LIMIT 1`, [entry.rows[0].id]);
    await expect(pool.query(`UPDATE journal_lines SET debit = debit + 1 WHERE id = $1`, [line.rows[0].id])).rejects.toThrow(/unbalanced/);
  });
});
