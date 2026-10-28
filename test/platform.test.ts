import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { setModel, type StructuredModel } from "../src/modules/ai/claude.js";
import { setMarketplaceAdapter, type MarketplaceAdapter } from "../src/modules/marketplace/adapter.js";
import { processOutbox } from "../src/modules/marketplace/worker.js";
import { N, signUp, session, useApp, type Session } from "./helpers.js";

const t = useApp();

function hs256(claims: object, secret: string) {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc(claims);
  const sig = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

describe("packages (Starter vs Pro)", () => {
  let starter: Session;
  beforeAll(async () => {
    starter = await signUp(t.app, { plan: "starter", verticals: ["dealer"] });
  });

  it("lists both packages publicly", async () => {
    const res = await t.app.inject({ method: "GET", url: "/plans" });
    expect(res.json().map((p: any) => p.id)).toEqual(["starter", "pro"]);
  });

  it("keeps Pro accounting behind an upgrade prompt", async () => {
    for (const url of ["/reports/balance-sheet", "/reports/cash-flow", "/reports/ar-aging", "/installments/due"]) {
      const res = await starter.raw("GET", url);
      expect(res.status, url).toBe(402);
      expect(res.body.details.upgradeTo).toBe("pro");
    }
    expect((await starter.raw("GET", "/reports/profit-and-loss")).status).toBe(200);
  });

  it("allows cash purchases on Starter but not credit bills or foreign currency", async () => {
    const sup = await starter.call("POST", "/contacts", { kind: "supplier", name: "Berger Motors" });
    expect((await starter.raw("POST", "/bills", { supplierId: sup.id, lines: [{ description: "Tyres", amount: N(80_000) }] })).status).toBe(402);
    const cashAcct = (await starter.call("GET", "/accounts")).find((a: any) => a.system_key === "cash").id;
    const ok = await starter.raw("POST", "/bills", { supplierId: sup.id, paidFromAccountId: cashAcct, lines: [{ description: "Tyres", amount: N(80_000) }] });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe("paid");
    const usd = await starter.raw("POST", "/bills", { supplierId: sup.id, currency: "USD", fxRate: 1500, paidFromAccountId: cashAcct, lines: [{ description: "Car", amount: 100 }] });
    expect(usd.status).toBe(402);
  });

  it("limits Starter to one business line", async () => {
    const res = await starter.raw("PATCH", "/organization", { verticals: ["dealer", "rental"] });
    expect(res.status).toBe(402);
  });

  it("upgrades through a signed Paystack webhook, and ignores underpayment", async () => {
    const send = (payload: object) => {
      const body = JSON.stringify(payload);
      const sig = crypto.createHmac("sha512", "sk_test_paystack").update(body).digest("hex");
      return t.app.inject({ method: "POST", url: "/webhooks/paystack", payload: body, headers: { "content-type": "application/json", "x-paystack-signature": sig } });
    };
    const cheap = await send({ event: "charge.success", data: { amount: 100, metadata: { orgId: starter.orgId, plan: "pro", interval: "monthly" } } });
    expect(cheap.json().ignored).toBe(true);

    const bad = await t.app.inject({ method: "POST", url: "/webhooks/paystack", payload: { event: "charge.success" }, headers: { "x-paystack-signature": "nope" } });
    expect(bad.statusCode).toBe(401);

    await send({ event: "charge.success", data: { amount: 45_000_00, customer: { customer_code: "CUS_1" }, metadata: { orgId: starter.orgId, plan: "pro", interval: "monthly" } } });
    const me = await starter.call("GET", "/me");
    expect(me.organization).toMatchObject({ plan: "pro", plan_status: "active" });
    expect((await starter.raw("GET", "/reports/balance-sheet")).status).toBe(200);
  });
});

describe("tenancy and roles", () => {
  it("never leaks one business's records to another", async () => {
    const a = await signUp(t.app);
    const b = await signUp(t.app);
    const cust = await a.call("POST", "/contacts", { kind: "customer", name: "Private Client" });
    const inv = await a.call("POST", "/invoices", { customerId: cust.id, lines: [{ description: "Service", unitPrice: N(10_000) }] });

    expect((await b.raw("GET", `/invoices/${inv.id}`)).status).toBe(404);
    expect((await b.raw("GET", `/contacts/${cust.id}`)).status).toBe(404);
    expect(await b.call("GET", "/invoices")).toHaveLength(0);
    // B cannot invoice A's customer either.
    expect((await b.raw("POST", "/invoices", { customerId: cust.id, lines: [{ description: "x", unitPrice: 1 }] })).status).toBe(400);
    // Nor select A's organisation with the header.
    const res = await t.app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${b.token}`, "x-org-id": a.orgId } });
    expect(res.statusCode).toBe(403);
  });

  it("restricts finance actions by role", async () => {
    const owner = await signUp(t.app);
    const invite = await owner.call("POST", "/organization/members", { email: `sales-${Date.now()}@example.com`, role: "sales" });
    const acc = await t.app.inject({ method: "POST", url: "/auth/accept-invite", payload: { token: invite.inviteToken, fullName: "Sales Rep", password: "password123" } });
    const sales = session(t.app, acc.json().token, owner.orgId, acc.json().user.id);
    expect((await sales.raw("GET", "/inventory")).status).toBe(200);
    expect((await sales.raw("POST", "/journal-entries", { date: "2026-01-01", memo: "x", lines: [] })).status).toBe(403);
    expect((await sales.raw("PATCH", "/organization", { name: "Hijack" })).status).toBe(403);
  });

  it("rejects manual journals to AR/AP control accounts", async () => {
    const s = await signUp(t.app);
    const accounts = await s.call("GET", "/accounts");
    const ar = accounts.find((a: any) => a.system_key === "ar").id;
    const cap = accounts.find((a: any) => a.system_key === "capital").id;
    const bank = accounts.find((a: any) => a.system_key === "bank").id;
    expect((await s.raw("POST", "/journal-entries", { date: "2026-01-01", memo: "plug", lines: [{ accountId: ar, debit: 5 }, { accountId: cap, credit: 5 }] })).status).toBe(400);
    expect((await s.raw("POST", "/journal-entries", { date: "2026-01-01", memo: "unbalanced", lines: [{ accountId: bank, debit: 5 }, { accountId: cap, credit: 4 }] })).status).toBe(400);
    expect((await s.raw("POST", "/journal-entries", { date: "2026-01-01", memo: "Owner capital", lines: [{ accountId: bank, debit: N(5_000_000) }, { accountId: cap, credit: N(5_000_000) }] })).status).toBe(201);
  });
});

describe("GreenRev single sign-on", () => {
  it("creates and then reuses a user from a GreenRev token", async () => {
    const claims = { sub: "gr_user_42", email: "kemi@greenrevs.com", name: "Kemi", exp: Math.floor(Date.now() / 1000) + 300 };
    const first = await t.app.inject({ method: "POST", url: "/auth/greenrev", payload: { token: hs256(claims, "sso-test-secret") } });
    expect(first.statusCode).toBe(200);
    expect(first.json().needsOnboarding).toBe(true);
    const second = await t.app.inject({ method: "POST", url: "/auth/greenrev", payload: { token: hs256(claims, "sso-test-secret") } });
    expect(second.json().user.id).toBe(first.json().user.id);

    const forged = await t.app.inject({ method: "POST", url: "/auth/greenrev", payload: { token: hs256(claims, "wrong") } });
    expect(forged.statusCode).toBe(401);
    const expired = await t.app.inject({ method: "POST", url: "/auth/greenrev", payload: { token: hs256({ ...claims, exp: 1 }, "sso-test-secret") } });
    expect(expired.statusCode).toBe(401);
  });
});

describe("marketplace link", () => {
  let s: Session;
  let item: any;
  beforeAll(async () => {
    s = await signUp(t.app, { plan: "pro", verticals: ["parts_vendor"] });
  });

  it("retries failed pushes with backoff and surfaces the error", async () => {
    let fail = true;
    const flaky: MarketplaceAdapter = {
      async upsert(listing) {
        if (fail) throw new Error("503 from marketplace");
        return { listingId: `mk-${listing.externalId}` };
      },
      async unpublish() {},
    };
    setMarketplaceAdapter(flaky);
    item = await s.call("POST", "/inventory/parts", { title: "Alternator – Camry 2012", unitPriceNgn: N(85_000), openingQuantity: 2, openingUnitCostNgn: N(50_000) });
    await processOutbox();
    let st = await s.call("GET", `/inventory/${item.id}`);
    expect(st.marketplace_status).toBe("pending");
    expect(st.marketplace_error).toMatch(/503/);

    fail = false;
    await pool.query(`UPDATE marketplace_outbox SET next_attempt_at = now() WHERE item_id = $1`, [item.id]);
    await processOutbox();
    st = await s.call("GET", `/inventory/${item.id}`);
    expect(st).toMatchObject({ marketplace_status: "listed", marketplace_listing_id: `mk-${item.id}`, marketplace_error: null });
  });

  it("records buyer enquiries from signed marketplace webhooks", async () => {
    const payload = JSON.stringify({ type: "lead.created", data: { listingId: `mk-${item.id}`, buyerName: "Emeka", buyerPhone: "+2348099999999", message: "Still available?" } });
    const sig = crypto.createHmac("sha256", "webhook-test-secret").update(payload).digest("hex");
    const res = await t.app.inject({ method: "POST", url: "/webhooks/greenrev", payload, headers: { "content-type": "application/json", "x-greenrev-signature": `sha256=${sig}` } });
    expect(res.json()).toEqual({ ok: true, matched: true });

    const unsigned = await t.app.inject({ method: "POST", url: "/webhooks/greenrev", payload, headers: { "content-type": "application/json" } });
    expect(unsigned.statusCode).toBe(401);

    const [lead] = await s.call("GET", "/leads");
    expect(lead).toMatchObject({ buyer_name: "Emeka", item_id: item.id, status: "new" });
    const converted = await s.call("PATCH", `/leads/${lead.id}`, { status: "contacted", createContact: true });
    expect(converted.contact_id).toBeTruthy();
    expect((await s.call("GET", "/dashboard")).leads.new).toBe(0);
  });
});

describe("AI smart upload", () => {
  let s: Session;
  const calls: any[] = [];
  beforeAll(async () => {
    s = await signUp(t.app, { plan: "starter", verticals: ["dealer"] });
    const fake: StructuredModel = {
      async run(args) {
        calls.push(args);
        const sys = args.system;
        const out = sys.includes("Vehicle Identification Numbers")
          ? { vin: "1HGCM82633A0O4352", confidence: "high", alternatives: [] }
          : {
              vin: "1HGCM82633A004352", vinConfidence: "high", make: "Honda", model: "Accord", yearEstimate: 2004, trim: "EX", bodyType: "sedan",
              color: "Silver", transmission: "automatic", fuelType: "petrol", mileageKm: 182000, plateNumber: null, conditionGuess: "nigerian_used",
              visibleDamage: ["scratch on rear bumper"], features: ["alloy wheels"],
              photoRoles: [{ index: 0, role: "front" }, { index: 1, role: "vin_plate" }], suggestedTitle: "2003 Honda Accord EX", notes: "",
            };
        return { output: args.schema.parse(out) as any, usage: { input_tokens: 1200, output_tokens: 300 } };
      },
    };
    setModel(fake);
  });

  function multipart(files: Array<{ name: string; type: string; data: Buffer }>, fields: Record<string, string> = {}) {
    const boundary = "----greenrev" + Math.random().toString(16).slice(2);
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    for (const f of files) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`), f.data, Buffer.from("\r\n"));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${s.token}` } };
  }
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  it("scans a VIN plate, correcting OCR mistakes before decoding", async () => {
    const res = await t.app.inject({ method: "POST", url: "/ai/vin-scan", ...multipart([{ name: "vin.jpg", type: "image/jpeg", data: jpeg }]) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ vin: "1HGCM82633A004352", decode: { checkDigitValid: true, make: "Honda" } });
  });

  it("turns car photos into a draft vehicle, keeping the VIN-plate photo private", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/ai/vehicle-intake",
      ...multipart([{ name: "front.jpg", type: "image/jpeg", data: jpeg }, { name: "vin.jpg", type: "image/jpeg", data: jpeg }], { create: "true" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // The check digit is valid, so the decoded year (2003) wins over the model's estimate (2004).
    expect(body.draft).toMatchObject({ vin: "1HGCM82633A004352", make: "Honda", year: 2003, mileageKm: 182000 });
    expect(body.item).toMatchObject({ status: "draft", vin: "1HGCM82633A004352", title: "2003 Honda Accord EX" });
    expect(body.item.photos).toHaveLength(1);
    // The model saw both images.
    expect(calls.at(-1).content.filter((c: any) => c.type === "image")).toHaveLength(2);
  });

  it("meters AI credits per package", async () => {
    await pool.query(`INSERT INTO ai_usage (org_id, feature) SELECT $1, 'test' FROM generate_series(1, 48)`, [s.orgId]);
    const credits = await s.call("GET", "/ai/credits");
    expect(credits).toEqual({ used: 50, limit: 50 });
    const res = await t.app.inject({ method: "POST", url: "/ai/vin-scan", ...multipart([{ name: "vin.jpg", type: "image/jpeg", data: jpeg }]) });
    expect(res.statusCode).toBe(402);
  });
});
