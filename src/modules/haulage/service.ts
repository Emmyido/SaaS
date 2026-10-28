import type { Db } from "../../db/pool.js";
import { one, many } from "../../db/pool.js";
import { conflict, notFound } from "../../lib/errors.js";
import { today } from "../../lib/dates.js";
import { nextNumber } from "../../lib/sequences.js";
import type { OrgContext } from "../../plugins/context.js";
import { assertContact } from "../contacts/service.js";
import { createInvoice } from "../accounting/invoices.js";

export interface TripInput {
  customerId: string;
  assetId?: string;
  driverName?: string;
  driverPhone?: string;
  origin: string;
  destination: string;
  cargo?: string;
  units?: number;
  pickupDate?: string;
  rateNgn: number;
  waybillNo?: string;
  notes?: string;
}

export async function createTrip(db: Db, ctx: OrgContext, input: TripInput) {
  await assertContact(db, ctx.orgId, input.customerId, "customer");
  if (input.assetId && !(await one(db, `SELECT 1 FROM fleet_assets WHERE id = $1 AND org_id = $2`, [input.assetId, ctx.orgId]))) throw notFound("Truck");
  const number = await nextNumber(db, ctx.orgId, "trip");
  const trip = await one(
    db,
    `INSERT INTO trips (org_id, number, customer_id, asset_id, driver_name, driver_phone, origin, destination, cargo, units, pickup_date, rate_ngn, waybill_no, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [ctx.orgId, number, input.customerId, input.assetId ?? null, input.driverName ?? null, input.driverPhone ?? null, input.origin, input.destination,
      input.cargo ?? null, input.units ?? 1, input.pickupDate ?? null, input.rateNgn, input.waybillNo ?? null, input.notes ?? null],
  );
  return getTrip(db, ctx.orgId, trip.id);
}

export async function getTrip(db: Db, orgId: string, id: string) {
  const trip = await one(
    db,
    `SELECT t.*, c.name AS customer_name, c.phone AS customer_phone, a.plate_number AS truck_plate, a.kind AS truck_kind
       FROM trips t JOIN contacts c ON c.id = t.customer_id LEFT JOIN fleet_assets a ON a.id = t.asset_id
      WHERE t.id = $1 AND t.org_id = $2`,
    [id, orgId],
  );
  if (!trip) throw notFound("Trip");
  trip.expenses = await many(db, `SELECT id, expense_date, category, description, amount_ngn, vat_ngn FROM expenses WHERE trip_id = $1 ORDER BY expense_date`, [id]);
  trip.total_expenses = trip.expenses.reduce((s: number, e: any) => s + e.amount_ngn, 0);
  trip.profit = trip.rate_ngn - trip.total_expenses;
  return trip;
}

const TRIP_FLOW: Record<string, string[]> = {
  booked: ["in_transit", "cancelled"],
  in_transit: ["delivered"],
  delivered: [],
};

export async function setTripStatus(db: Db, ctx: OrgContext, id: string, status: string, date?: string) {
  const trip = await one(db, `SELECT * FROM trips WHERE id = $1 AND org_id = $2 FOR UPDATE`, [id, ctx.orgId]);
  if (!trip) throw notFound("Trip");
  if (!(TRIP_FLOW[trip.status] ?? []).includes(status)) throw conflict(`Cannot move a trip from ${trip.status} to ${status}`);
  const d = date ?? today();
  await db.query(
    `UPDATE trips SET status = $2,
            pickup_date = CASE WHEN $2 = 'in_transit' THEN COALESCE(pickup_date, $3::date) ELSE pickup_date END,
            delivery_date = CASE WHEN $2 = 'delivered' THEN $3::date ELSE delivery_date END
      WHERE id = $1`,
    [id, status, d],
  );
  if (trip.asset_id) {
    const assetStatus = status === "in_transit" ? "on_trip" : "available";
    await db.query(`UPDATE fleet_assets SET status = $2 WHERE id = $1 AND status <> 'retired'`, [trip.asset_id, assetStatus]);
  }
  return getTrip(db, ctx.orgId, id);
}

export async function invoiceTrip(db: Db, ctx: OrgContext, id: string, opts: { issueDate?: string; dueDate?: string; vatRateBp?: number } = {}) {
  const trip = await getTrip(db, ctx.orgId, id);
  if (trip.invoice_id) throw conflict("Trip is already invoiced");
  if (trip.status === "cancelled") throw conflict("Trip is cancelled");
  const invoice = await createInvoice(db, ctx, {
    customerId: trip.customer_id,
    issueDate: opts.issueDate ?? today(),
    dueDate: opts.dueDate,
    sourceType: "trip",
    sourceId: id,
    lines: [{
      description: `Haulage ${trip.origin} → ${trip.destination}${trip.cargo ? ` (${trip.cargo})` : ""}${trip.waybill_no ? `, waybill ${trip.waybill_no}` : ""}`,
      quantity: 1,
      unitPrice: trip.rate_ngn,
      vatRateBp: opts.vatRateBp,
    }],
  });
  await db.query(`UPDATE trips SET status = CASE WHEN status = 'delivered' THEN 'invoiced' ELSE status END, invoice_id = $2 WHERE id = $1`, [id, invoice.id]);
  return invoice;
}

/** Revenue vs direct costs per truck for a period. */
export async function fleetProfitability(db: Db, orgId: string, from: string, to: string) {
  return many(
    db,
    `SELECT a.id, a.plate_number, a.kind, count(t.id)::int AS trips,
            COALESCE(SUM(t.rate_ngn), 0)::bigint AS revenue,
            COALESCE(SUM((SELECT COALESCE(SUM(e.amount_ngn), 0) FROM expenses e WHERE e.trip_id = t.id)), 0)::bigint AS costs
       FROM fleet_assets a LEFT JOIN trips t ON t.asset_id = a.id AND t.status <> 'cancelled' AND COALESCE(t.pickup_date, t.created_at::date) BETWEEN $2 AND $3
      WHERE a.org_id = $1 GROUP BY a.id ORDER BY revenue DESC`,
    [orgId, from, to],
  ).then((rows) => rows.map((r) => ({ ...r, profit: r.revenue - r.costs })));
}
