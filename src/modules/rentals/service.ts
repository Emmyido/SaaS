import type { Db } from "../../db/pool.js";
import { one, many } from "../../db/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { daysBetween, today } from "../../lib/dates.js";
import { nextNumber } from "../../lib/sequences.js";
import type { OrgContext } from "../../plugins/context.js";
import { assertContact } from "../contacts/service.js";
import { createInvoice, getInvoice, type InvoiceLineInput } from "../accounting/invoices.js";
import { applyDeposit, depositBalance, receivePayment, type Method } from "../accounting/payments.js";

export interface BookingInput {
  customerId: string;
  itemId: string;
  startDate: string;
  endDate: string;
  dailyRateNgn?: number;
  depositNgn?: number;
  withDriver?: boolean;
  /** Collect the security deposit now. */
  collectDeposit?: { method: Method; accountId?: string; reference?: string };
}

export async function createBooking(db: Db, ctx: OrgContext, input: BookingInput) {
  await assertContact(db, ctx.orgId, input.customerId, "customer");
  const car = await one(db, `SELECT * FROM inventory_items WHERE id = $1 AND org_id = $2`, [input.itemId, ctx.orgId]);
  if (!car) throw notFound("Vehicle");
  if (!car.is_rentable) throw badRequest(`${car.title} is not in the rental fleet`);
  if (["sold", "archived"].includes(car.status)) throw conflict(`${car.title} is ${car.status}`);
  const rate = input.dailyRateNgn ?? car.daily_rate_ngn;
  if (!rate) throw badRequest("Set a daily rate on the vehicle or the booking");
  const number = await nextNumber(db, ctx.orgId, "rental");
  let booking;
  try {
    await db.query("SAVEPOINT booking");
    booking = await one(
      db,
      `INSERT INTO rental_bookings (org_id, number, customer_id, item_id, start_date, end_date, daily_rate_ngn, deposit_ngn, with_driver)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [ctx.orgId, number, input.customerId, input.itemId, input.startDate, input.endDate, rate, input.depositNgn ?? 0, input.withDriver ?? false],
    );
    await db.query("RELEASE SAVEPOINT booking");
  } catch (err: any) {
    await db.query("ROLLBACK TO SAVEPOINT booking");
    if (err.code === "23P01") throw conflict(`${car.title} is already booked for part of ${input.startDate} – ${input.endDate}`);
    throw err;
  }
  if (input.collectDeposit && (input.depositNgn ?? 0) > 0) {
    await receivePayment(db, ctx, {
      customerId: input.customerId,
      date: today(),
      amount: input.depositNgn!,
      method: input.collectDeposit.method,
      accountId: input.collectDeposit.accountId,
      reference: input.collectDeposit.reference ?? `Deposit ${number}`,
      allocations: [],
    });
  }
  return getBooking(db, ctx.orgId, booking!.id);
}

export async function getBooking(db: Db, orgId: string, id: string) {
  const b = await one(
    db,
    `SELECT b.*, c.name AS customer_name, c.phone AS customer_phone, i.title AS vehicle_title, i.plate_number
       FROM rental_bookings b JOIN contacts c ON c.id = b.customer_id JOIN inventory_items i ON i.id = b.item_id
      WHERE b.id = $1 AND b.org_id = $2`,
    [id, orgId],
  );
  if (!b) throw notFound("Booking");
  b.days = daysBetween(b.start_date, b.end_date) + 1;
  b.estimate = b.days * b.daily_rate_ngn;
  return b;
}

export async function checkOut(db: Db, ctx: OrgContext, id: string, mileage?: number) {
  const b = await one(db, `SELECT * FROM rental_bookings WHERE id = $1 AND org_id = $2 FOR UPDATE`, [id, ctx.orgId]);
  if (!b) throw notFound("Booking");
  if (b.status !== "reserved") throw conflict(`Booking is ${b.status}`);
  const car = await one(db, `SELECT status, title FROM inventory_items WHERE id = $1 FOR UPDATE`, [b.item_id]);
  if (car.status === "rented") throw conflict(`${car.title} is still out on another rental`);
  if (car.status === "in_repair") throw conflict(`${car.title} is in the workshop`);
  await db.query(`UPDATE rental_bookings SET status = 'active', checkout_mileage = $2 WHERE id = $1`, [id, mileage ?? null]);
  await db.query(`UPDATE inventory_items SET status = 'rented', mileage_km = COALESCE($2, mileage_km) WHERE id = $1`, [b.item_id, mileage ?? null]);
  return getBooking(db, ctx.orgId, id);
}

/** Return the car; late days are charged at the daily rate unless a late fee is given. */
export async function checkIn(db: Db, ctx: OrgContext, id: string, input: { returnedOn?: string; mileage?: number; damageFeeNgn?: number; lateFeeNgn?: number }) {
  const b = await one(db, `SELECT * FROM rental_bookings WHERE id = $1 AND org_id = $2 FOR UPDATE`, [id, ctx.orgId]);
  if (!b) throw notFound("Booking");
  if (b.status !== "active") throw conflict(`Booking is ${b.status}`);
  const returnedOn = input.returnedOn ?? today();
  if (input.mileage !== undefined && b.checkout_mileage !== null && input.mileage < b.checkout_mileage) throw badRequest("Return mileage is lower than checkout mileage");
  const lateDays = Math.max(0, daysBetween(b.end_date, returnedOn));
  const lateFee = input.lateFeeNgn ?? lateDays * b.daily_rate_ngn;
  await db.query(
    `UPDATE rental_bookings SET status = 'returned', returned_on = $2, checkin_mileage = $3, late_fee_ngn = $4, damage_fee_ngn = $5 WHERE id = $1`,
    [id, returnedOn, input.mileage ?? null, lateFee, input.damageFeeNgn ?? 0],
  );
  await db.query(`UPDATE inventory_items SET status = 'in_stock', mileage_km = COALESCE($2, mileage_km) WHERE id = $1`, [b.item_id, input.mileage ?? null]);
  return getBooking(db, ctx.orgId, id);
}

/** Invoice a returned rental and (optionally) settle it from the customer's deposit. */
export async function invoiceBooking(db: Db, ctx: OrgContext, id: string, opts: { issueDate?: string; applyDeposit?: boolean; vatRateBp?: number } = {}) {
  const b = await getBooking(db, ctx.orgId, id);
  if (b.status !== "returned") throw conflict(b.status === "invoiced" ? "Booking is already invoiced" : "Check the car in before invoicing");
  const issueDate = opts.issueDate ?? today();
  const lines: InvoiceLineInput[] = [{
    description: `Rental of ${b.vehicle_title}${b.plate_number ? ` (${b.plate_number})` : ""}, ${b.start_date} to ${b.end_date}${b.with_driver ? ", with driver" : ""}`,
    quantity: b.days,
    unitPrice: b.daily_rate_ngn,
    vatRateBp: opts.vatRateBp,
  }];
  if (b.late_fee_ngn > 0) lines.push({ description: `Late return (${b.returned_on})`, unitPrice: b.late_fee_ngn, vatRateBp: opts.vatRateBp });
  if (b.damage_fee_ngn > 0) lines.push({ description: "Damage charge", unitPrice: b.damage_fee_ngn, vatRateBp: 0 });
  const invoice = await createInvoice(db, ctx, { customerId: b.customer_id, issueDate, sourceType: "rental", sourceId: id, lines });
  await db.query(`UPDATE rental_bookings SET status = 'invoiced', invoice_id = $2 WHERE id = $1`, [id, invoice.id]);
  if (opts.applyDeposit ?? true) {
    const held = await depositBalance(db, ctx.orgId, b.customer_id);
    const amount = Math.min(held, invoice.balance);
    if (amount > 0) await applyDeposit(db, ctx, { customerId: b.customer_id, invoiceId: invoice.id, amount, date: issueDate });
  }
  return getInvoice(db, ctx.orgId, invoice.id);
}

export async function cancelBooking(db: Db, ctx: OrgContext, id: string) {
  const r = await db.query(`UPDATE rental_bookings SET status = 'cancelled' WHERE id = $1 AND org_id = $2 AND status = 'reserved' RETURNING id`, [id, ctx.orgId]);
  if (!r.rowCount) throw conflict("Only reserved bookings can be cancelled");
  return getBooking(db, ctx.orgId, id);
}

/** Which rental cars are free for a date range. */
export async function availability(db: Db, orgId: string, from: string, to: string) {
  return many(
    db,
    `SELECT i.id, i.title, i.plate_number, i.daily_rate_ngn, i.status,
            NOT EXISTS (SELECT 1 FROM rental_bookings b WHERE b.item_id = i.id AND b.status IN ('reserved', 'active')
                         AND daterange(b.start_date, b.end_date, '[]') && daterange($2::date, $3::date, '[]')) AS available
       FROM inventory_items i WHERE i.org_id = $1 AND i.is_rentable AND i.status NOT IN ('sold', 'archived') ORDER BY i.title`,
    [orgId, from, to],
  );
}

/** Utilisation and revenue per rental car. */
export async function utilisation(db: Db, orgId: string, from: string, to: string) {
  const span = daysBetween(from, to) + 1;
  const rows = await many(
    db,
    `SELECT i.id, i.title, i.plate_number,
            COALESCE(SUM(GREATEST(0, LEAST(b.end_date, $3::date) - GREATEST(b.start_date, $2::date) + 1)), 0)::int AS days_booked,
            COALESCE(SUM(inv.total), 0)::bigint AS invoiced
       FROM inventory_items i
       LEFT JOIN rental_bookings b ON b.item_id = i.id AND b.status <> 'cancelled' AND b.start_date <= $3 AND b.end_date >= $2
       LEFT JOIN invoices inv ON inv.id = b.invoice_id AND inv.status <> 'void'
      WHERE i.org_id = $1 AND i.is_rentable GROUP BY i.id ORDER BY days_booked DESC`,
    [orgId, from, to],
  );
  return rows.map((r) => ({ ...r, utilisationPct: Math.round((r.days_booked / span) * 1000) / 10 }));
}
