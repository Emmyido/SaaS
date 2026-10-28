import { beforeAll, describe, expect, it } from "vitest";
import { accountBalance, N, signUp, useApp, type Session } from "./helpers.js";

describe("parts vendor + workshop", () => {
  const t = useApp();
  let s: Session;
  let supplier: any, customer: any, pads: any;

  beforeAll(async () => {
    s = await signUp(t.app, { plan: "pro", verticals: ["mechanic", "parts_vendor"] });
    supplier = await s.call("POST", "/contacts", { kind: "supplier", name: "Ladipo Spares" });
    customer = await s.call("POST", "/contacts", { kind: "customer", name: "Bola Ahmed" });
  });

  it("keeps weighted-average cost across opening stock and purchases", async () => {
    pads = await s.call("POST", "/inventory/parts", {
      title: "Brake pads (front) – Corolla 2014-2019",
      sku: "BP-COR-14",
      partNumber: "04465-02220",
      compatibleWith: ["Toyota Corolla 2014-2019"],
      unitPriceNgn: N(9_000),
      reorderLevel: 5,
      openingQuantity: 10,
      openingUnitCostNgn: N(5_000),
    });
    expect(pads).toMatchObject({ quantity: 10, unit_cost_ngn: N(5_000) });

    await s.call("POST", "/bills", {
      supplierId: supplier.id,
      lines: [{ description: "Brake pads x10", amount: N(70_000), itemId: pads.id, quantity: 10 }],
    });
    const after = await s.call("GET", `/inventory/${pads.id}`);
    expect(after).toMatchObject({ quantity: 20, unit_cost_ngn: N(6_000), stock_value_ngn: N(120_000) });
  });

  it("turns a job card into a VAT invoice, issuing parts at cost", async () => {
    const job = await s.call("POST", "/job-cards", {
      customerId: customer.id,
      vehicleDesc: "2016 Toyota Corolla",
      plateNumber: "LND-452-XY",
      complaint: "Grinding noise when braking",
      lines: [
        { kind: "labour", description: "Replace front pads, skim discs", unitPrice: N(20_000) },
        { kind: "part", itemId: pads.id, quantity: 3 },
      ],
    });
    expect(job.estimate).toBe(N(47_000));
    await s.call("POST", `/job-cards/${job.id}/status`, { status: "completed", diagnosis: "Pads worn to metal" });

    const inv = await s.call("POST", `/job-cards/${job.id}/invoice`, { issueDate: "2026-05-02", dueDate: "2026-05-09" });
    expect(inv).toMatchObject({ subtotal: N(47_000), vat_total: N(3_525), total: N(50_525), source_type: "job_card" });
    expect((await s.call("GET", `/inventory/${pads.id}`)).quantity).toBe(17);
    expect(await accountBalance(s.orgId, "cogs_parts")).toBe(N(18_000));
    expect(await accountBalance(s.orgId, "service_income")).toBe(-N(20_000));
    expect(await accountBalance(s.orgId, "sales_parts")).toBe(-N(27_000));
    expect(await accountBalance(s.orgId, "vat_output")).toBe(-N(3_525));

    // Early-payment discount settles the invoice in full.
    await s.call("POST", "/payments/receive", {
      customerId: customer.id, date: "2026-05-03", amount: N(50_000), method: "pos",
      allocations: [{ invoiceId: inv.id, amount: N(50_000), discount: N(525) }],
    });
    const paid = await s.call("GET", `/invoices/${inv.id}`);
    expect(paid).toMatchObject({ status: "paid", balance: 0, amount_credited: N(525) });
    expect(await accountBalance(s.orgId, "discounts_allowed")).toBe(N(525));
    expect(await accountBalance(s.orgId, "pos_clearing")).toBe(N(50_000));

    const again = await s.raw("POST", `/job-cards/${job.id}/invoice`, {});
    expect(again.status).toBe(409);
  });

  it("refuses to sell more parts than are in stock, and voids restore stock", async () => {
    const over = await s.raw("POST", "/invoices", { customerId: customer.id, lines: [{ itemId: pads.id, quantity: 50, unitPrice: N(9_000) }] });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/Only 17/);

    const inv = await s.call("POST", "/invoices", { customerId: customer.id, lines: [{ itemId: pads.id, quantity: 2, unitPrice: N(9_000) }] });
    expect((await s.call("GET", `/inventory/${pads.id}`)).quantity).toBe(15);
    await s.call("POST", `/invoices/${inv.id}/void`, {});
    expect((await s.call("GET", `/inventory/${pads.id}`)).quantity).toBe(17);
    const tb = await s.call("GET", "/reports/trial-balance");
    expect(tb.balanced).toBe(true);
  });

  it("posts stock count write-offs and flags reorders", async () => {
    await s.call("POST", `/inventory/${pads.id}/adjust-stock`, { quantity: -13, note: "Damaged in store" });
    const low = await s.call("GET", "/inventory?lowStock=true");
    expect(low.items.map((i: any) => i.id)).toContain(pads.id);
    expect(await accountBalance(s.orgId, "stock_adjustments")).toBe(N(78_000));
  });

  it("blocks dealer-only verticals it has not enabled", async () => {
    const res = await s.raw("GET", "/trips");
    expect(res.status).toBe(403);
  });
});

describe("haulage", () => {
  const t = useApp();
  let s: Session;

  beforeAll(async () => {
    s = await signUp(t.app, { plan: "pro", verticals: ["haulage"] });
  });

  it("runs a trip from booking to invoice and reports profit per truck", async () => {
    const client = await s.call("POST", "/contacts", { kind: "customer", name: "Coscharis Motors" });
    const truck = await s.call("POST", "/fleet", { kind: "car_carrier", plateNumber: "KJA-881-AB", capacity: "8 cars" });
    const trip = await s.call("POST", "/trips", {
      customerId: client.id, assetId: truck.id, origin: "Apapa Port, Lagos", destination: "Wuse, Abuja", cargo: "6 SUVs", units: 6,
      rateNgn: N(1_800_000), driverName: "Musa Bello",
    });
    await s.call("POST", `/trips/${trip.id}/status`, { status: "in_transit", date: "2026-06-01" });
    expect((await s.call("GET", "/fleet"))[0].status).toBe("on_trip");

    await s.call("POST", "/expenses", { date: "2026-06-01", category: "fuel", description: "Diesel", amount: N(450_000), tripId: trip.id });
    await s.call("POST", "/expenses", { date: "2026-06-02", category: "tolls", description: "Tolls & checkpoints", amount: N(60_000), tripId: trip.id });
    await s.call("POST", `/trips/${trip.id}/status`, { status: "delivered", date: "2026-06-02" });

    const inv = await s.call("POST", `/trips/${trip.id}/invoice`, { issueDate: "2026-06-02" });
    expect(inv.total).toBe(N(1_935_000)); // VAT 7.5% on ₦1.8m
    const full = await s.call("GET", `/trips/${trip.id}`);
    expect(full).toMatchObject({ status: "invoiced", total_expenses: N(510_000), profit: N(1_290_000) });

    const fleet = await s.call("GET", "/reports/fleet-profitability?from=2026-01-01&to=2026-12-31");
    expect(fleet[0]).toMatchObject({ plate_number: "KJA-881-AB", trips: 1, revenue: N(1_800_000), costs: N(510_000), profit: N(1_290_000) });
    expect(await accountBalance(s.orgId, "haulage_income")).toBe(-N(1_800_000));
  });
});

describe("car rental", () => {
  const t = useApp();
  let s: Session;
  let customer: any, car: any;

  beforeAll(async () => {
    s = await signUp(t.app, { plan: "pro", verticals: ["rental"] });
    customer = await s.call("POST", "/contacts", { kind: "customer", name: "Tolu Adeyemi" });
    car = await s.call("POST", "/inventory/vehicles", {
      make: "Toyota", model: "Prado", year: 2021, plateNumber: "ABJ-100-RT", isRentable: true, dailyRateNgn: N(120_000), openingCostNgn: N(60_000_000),
    });
  });

  it("puts rental cars on the fixed-asset register, not trading stock", async () => {
    expect(car.publish_to_marketplace).toBe(false);
    expect(await accountBalance(s.orgId, "fixed_assets")).toBe(N(60_000_000));
    expect(await accountBalance(s.orgId, "inventory_vehicles")).toBe(0);
  });

  it("books, rejects double-booking, handles deposit, late return and invoice", async () => {
    const booking = await s.call("POST", "/rentals", {
      customerId: customer.id, itemId: car.id, startDate: "2026-07-01", endDate: "2026-07-03", depositNgn: N(200_000),
      collectDeposit: { method: "transfer" },
    });
    expect(booking).toMatchObject({ days: 3, estimate: N(360_000) });
    expect((await s.call("GET", `/contacts/${customer.id}`)).deposit_balance).toBe(N(200_000));

    const clash = await s.raw("POST", "/rentals", { customerId: customer.id, itemId: car.id, startDate: "2026-07-03", endDate: "2026-07-05" });
    expect(clash.status).toBe(409);

    const avail = await s.call("GET", "/rentals/availability?from=2026-07-02&to=2026-07-02");
    expect(avail[0].available).toBe(false);

    await s.call("POST", `/rentals/${booking.id}/check-out`, { mileage: 12000 });
    expect((await s.call("GET", `/inventory/${car.id}`)).status).toBe("rented");

    const returned = await s.call("POST", `/rentals/${booking.id}/check-in`, { returnedOn: "2026-07-04", mileage: 12650 });
    expect(returned.late_fee_ngn).toBe(N(120_000));

    const inv = await s.call("POST", `/rentals/${booking.id}/invoice`, { issueDate: "2026-07-04", vatRateBp: 0 });
    expect(inv.total).toBe(N(480_000));
    expect(inv.balance).toBe(N(280_000)); // deposit applied
    expect((await s.call("GET", `/contacts/${customer.id}`)).deposit_balance).toBe(0);
    expect((await s.call("GET", `/inventory/${car.id}`)).status).toBe("in_stock");

    const util = await s.call("GET", "/reports/rental-utilisation?from=2026-07-01&to=2026-07-10");
    expect(util[0]).toMatchObject({ days_booked: 3, utilisationPct: 30 });
  });
});
