import type { Db } from "../../db/pool.js";
import { one, many } from "../../db/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { today } from "../../lib/dates.js";
import { nextNumber } from "../../lib/sequences.js";
import type { OrgContext } from "../../plugins/context.js";
import { assertContact } from "../contacts/service.js";
import { createInvoice, type InvoiceLineInput } from "../accounting/invoices.js";

export interface JobCardInput {
  customerId: string;
  itemId?: string;
  vehicleDesc?: string;
  vin?: string;
  plateNumber?: string;
  odometerKm?: number;
  complaint?: string;
  diagnosis?: string;
  assignedTo?: string;
  promisedAt?: string;
  lines?: JobLineInput[];
}

export interface JobLineInput {
  kind: "labour" | "part";
  itemId?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
}

export async function createJobCard(db: Db, ctx: OrgContext, input: JobCardInput) {
  await assertContact(db, ctx.orgId, input.customerId, "customer");
  const number = await nextNumber(db, ctx.orgId, "job_card");
  const job = await one(
    db,
    `INSERT INTO job_cards (org_id, number, customer_id, item_id, vehicle_desc, vin, plate_number, odometer_km, complaint, diagnosis, assigned_to, promised_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [ctx.orgId, number, input.customerId, input.itemId ?? null, input.vehicleDesc ?? null, input.vin ?? null, input.plateNumber ?? null,
      input.odometerKm ?? null, input.complaint ?? null, input.diagnosis ?? null, input.assignedTo ?? null, input.promisedAt ?? null],
  );
  if (input.itemId) {
    await db.query(`UPDATE inventory_items SET status = 'in_repair' WHERE id = $1 AND org_id = $2 AND status = 'in_stock'`, [input.itemId, ctx.orgId]);
  }
  for (const l of input.lines ?? []) await addJobLine(db, ctx, job.id, l);
  return getJobCard(db, ctx.orgId, job.id);
}

export async function addJobLine(db: Db, ctx: OrgContext, jobId: string, l: JobLineInput) {
  const job = await one(db, `SELECT status FROM job_cards WHERE id = $1 AND org_id = $2`, [jobId, ctx.orgId]);
  if (!job) throw notFound("Job card");
  if (["invoiced", "cancelled"].includes(job.status)) throw conflict(`Job card is ${job.status}`);
  let description = l.description;
  let price = l.unitPrice;
  if (l.itemId) {
    const item = await one(db, `SELECT title, kind, unit_price_ngn FROM inventory_items WHERE id = $1 AND org_id = $2`, [l.itemId, ctx.orgId]);
    if (!item) throw notFound("Part");
    if (item.kind === "vehicle") throw badRequest("Only parts can be added to a job card");
    description ??= item.title;
    price ??= item.unit_price_ngn ?? 0;
  }
  if (!description) throw badRequest("Describe the labour or part");
  return one(
    db,
    `INSERT INTO job_card_lines (job_card_id, org_id, kind, item_id, description, quantity, unit_price) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [jobId, ctx.orgId, l.kind, l.itemId ?? null, description, l.quantity ?? 1, price ?? 0],
  );
}

export async function getJobCard(db: Db, orgId: string, id: string) {
  const job = await one(
    db,
    `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone FROM job_cards j JOIN contacts c ON c.id = j.customer_id WHERE j.id = $1 AND j.org_id = $2`,
    [id, orgId],
  );
  if (!job) throw notFound("Job card");
  job.lines = await many(db, `SELECT * FROM job_card_lines WHERE job_card_id = $1 ORDER BY id`, [id]);
  job.estimate = job.lines.reduce((s: number, l: any) => s + Math.round(Number(l.quantity) * l.unit_price), 0);
  job.expenses = await many(db, `SELECT id, expense_date, description, amount_ngn FROM expenses WHERE job_card_id = $1`, [id]);
  return job;
}

const TRANSITIONS: Record<string, string[]> = {
  open: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: ["in_progress"],
};

export async function setJobStatus(db: Db, ctx: OrgContext, id: string, status: string, diagnosis?: string) {
  const job = await one(db, `SELECT * FROM job_cards WHERE id = $1 AND org_id = $2 FOR UPDATE`, [id, ctx.orgId]);
  if (!job) throw notFound("Job card");
  if (!(TRANSITIONS[job.status] ?? []).includes(status)) throw conflict(`Cannot move a job card from ${job.status} to ${status}`);
  await db.query(
    `UPDATE job_cards SET status = $2, diagnosis = COALESCE($3, diagnosis), completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END WHERE id = $1`,
    [id, status, diagnosis ?? null],
  );
  if (job.item_id && ["completed", "cancelled"].includes(status)) {
    await db.query(`UPDATE inventory_items SET status = 'in_stock' WHERE id = $1 AND status = 'in_repair'`, [job.item_id]);
  }
  return getJobCard(db, ctx.orgId, id);
}

/** Bill the customer: labour to Workshop Income, stocked parts issued from inventory at cost. */
export async function invoiceJobCard(db: Db, ctx: OrgContext, id: string, opts: { issueDate?: string; dueDate?: string; discount?: number } = {}) {
  const job = await getJobCard(db, ctx.orgId, id);
  if (job.status === "invoiced") throw conflict("Job card is already invoiced");
  if (job.status === "cancelled") throw conflict("Job card is cancelled");
  if (job.lines.length === 0) throw badRequest("Add labour or parts before invoicing");
  const lines: InvoiceLineInput[] = job.lines.map((l: any) => ({
    itemId: l.kind === "part" ? l.item_id ?? undefined : undefined,
    description: l.description,
    quantity: Number(l.quantity),
    unitPrice: l.unit_price,
    revenueKey: l.kind === "labour" ? "service_income" : "sales_parts",
  }));
  const invoice = await createInvoice(db, ctx, {
    customerId: job.customer_id,
    issueDate: opts.issueDate ?? today(),
    dueDate: opts.dueDate,
    discount: opts.discount,
    lines,
    sourceType: "job_card",
    sourceId: id,
    notes: [job.vehicle_desc, job.plate_number, job.vin && `VIN ${job.vin}`].filter(Boolean).join(" · ") || undefined,
  });
  await db.query(`UPDATE job_cards SET status = 'invoiced', invoice_id = $2, completed_at = COALESCE(completed_at, now()) WHERE id = $1`, [id, invoice.id]);
  if (job.item_id) await db.query(`UPDATE inventory_items SET status = 'in_stock' WHERE id = $1 AND status = 'in_repair'`, [job.item_id]);
  return invoice;
}
