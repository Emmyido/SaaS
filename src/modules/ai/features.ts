import { z } from "zod";
import { pool, one, many } from "../../db/pool.js";
import { badRequest } from "../../lib/errors.js";
import { decodeVinLocally, normaliseVin, type LocalVinDecode } from "../../lib/vin.js";
import { readStoredFile } from "../../lib/storage.js";
import type { OrgContext } from "../../plugins/context.js";
import { EXPENSE_CATEGORIES } from "../accounting/chart.js";
import { imageBlock, runAi, type ImageInput } from "./claude.js";

const NIGERIA_CONTEXT =
  "You work inside GreenRev Business Suite, used by Nigerian car dealers, mechanics, parts vendors, haulage and car rental operators. " +
  "Prices are in Naira. Local terms: 'Tokunbo' = foreign used, 'Nigerian used' = locally used, 'Brand new'.";

// ------------------------------------------------------------------ VIN decode

export interface VinDecodeResult extends LocalVinDecode {
  source: "nhtsa" | "local";
  model: string | null;
  trim: string | null;
  bodyType: string | null;
  engine: string | null;
  fuelType: string | null;
  transmission: string | null;
  driveType: string | null;
  doors: number | null;
}

/** Decode with the free NHTSA vPIC service (best for US-spec imports), falling back to the offline decoder. */
export async function decodeVin(raw: string): Promise<VinDecodeResult> {
  const local = decodeVinLocally(raw);
  const base: VinDecodeResult = { ...local, source: "local", model: null, trim: null, bodyType: null, engine: null, fuelType: null, transmission: null, driveType: null, doors: null };
  if (!local.wellFormed) return base;
  try {
    const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${local.vin}?format=json`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return base;
    const json: any = await res.json();
    const r = json?.Results?.[0];
    if (!r || !r.Make) return base;
    const s = (v: string) => (v && v !== "Not Applicable" ? v : null);
    const engine = [s(r.DisplacementL) && `${Number(r.DisplacementL).toFixed(1)}L`, s(r.EngineCylinders) && `${r.EngineCylinders}-cyl`, s(r.EngineModel)].filter(Boolean).join(" ");
    return {
      ...base,
      source: "nhtsa",
      make: titleCase(r.Make) ?? base.make,
      model: s(r.Model),
      modelYear: Number(r.ModelYear) || base.modelYear,
      trim: s(r.Trim),
      bodyType: s(r.BodyClass),
      engine: engine || null,
      fuelType: s(r.FuelTypePrimary),
      transmission: s(r.TransmissionStyle),
      driveType: s(r.DriveType),
      doors: Number(r.Doors) || null,
      country: s(r.PlantCountry) ?? base.country,
    };
  } catch {
    return base;
  }
}

function titleCase(s: string | null): string | null {
  if (!s) return null;
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bBmw\b/, "BMW").replace(/\bGmc\b/, "GMC");
}

// ------------------------------------------------------------------ vehicle photo intake

const VehicleIntake = z.object({
  vin: z.string().nullable().describe("17-character VIN if clearly readable in any photo (VIN plate, windscreen, door jamb, papers), else null"),
  vinConfidence: z.enum(["high", "medium", "low", "none"]),
  make: z.string().nullable(),
  model: z.string().nullable(),
  yearEstimate: z.number().int().nullable(),
  trim: z.string().nullable(),
  bodyType: z.enum(["sedan", "suv", "hatchback", "pickup", "van", "bus", "coupe", "wagon", "truck", "other"]).nullable(),
  color: z.string().nullable(),
  transmission: z.enum(["automatic", "manual"]).nullable(),
  fuelType: z.enum(["petrol", "diesel", "hybrid", "electric", "cng"]).nullable(),
  mileageKm: z.number().int().nullable().describe("Odometer reading in km if visible; convert miles to km"),
  plateNumber: z.string().nullable(),
  conditionGuess: z.enum(["brand_new", "foreign_used", "nigerian_used"]).nullable(),
  visibleDamage: z.array(z.string()).describe("Dents, scratches, rust, cracked glass, worn tyres, etc."),
  features: z.array(z.string()).describe("Visible features: leather seats, sunroof, alloy wheels, reverse camera..."),
  photoRoles: z.array(z.object({ index: z.number().int(), role: z.enum(["front", "rear", "side", "interior", "dashboard", "engine", "vin_plate", "document", "other"]) })),
  suggestedTitle: z.string(),
  notes: z.string().describe("Anything the dealer should double-check"),
});
export type VehicleIntakeResult = z.infer<typeof VehicleIntake>;

/** Read a set of photos of a car (exterior, interior, dashboard, VIN plate) and pre-fill the vehicle form. */
export async function vehicleIntake(ctx: OrgContext, images: ImageInput[]) {
  if (images.length === 0) throw badRequest("Upload at least one photo");
  if (images.length > 12) throw badRequest("Upload at most 12 photos at a time");
  const output = await runAi(ctx, "vehicle_intake", {
    system: `${NIGERIA_CONTEXT} You extract vehicle details from photos for an inventory record. Only report what the photos support; use null when unsure. Never invent a VIN.`,
    content: [
      ...images.map(imageBlock),
      { type: "text", text: `These ${images.length} photos (indexed from 0 in order) show one vehicle being added to a dealer's inventory. Extract its details.` },
    ],
    schema: VehicleIntake,
    effort: "medium",
  });
  let vinDecode: VinDecodeResult | null = null;
  if (output.vin) {
    output.vin = normaliseVin(output.vin);
    vinDecode = await decodeVin(output.vin);
  }
  // Cross-check: prefer the decoder for make/year when the VIN is valid.
  const merged = {
    vin: output.vin,
    make: vinDecode?.checkDigitValid && vinDecode.make ? vinDecode.make : output.make,
    model: vinDecode?.model ?? output.model,
    year: vinDecode?.checkDigitValid && vinDecode.modelYear ? vinDecode.modelYear : output.yearEstimate,
    trim: vinDecode?.trim ?? output.trim,
    bodyType: output.bodyType,
    color: output.color,
    transmission: output.transmission,
    fuelType: output.fuelType,
    mileageKm: output.mileageKm,
    plateNumber: output.plateNumber,
    condition: output.conditionGuess,
    engine: vinDecode?.engine ?? null,
  };
  return { draft: merged, ai: output, vinDecode };
}

// ------------------------------------------------------------------ VIN from a single photo

const VinRead = z.object({
  vin: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low", "none"]),
  alternatives: z.array(z.string()).describe("Other readings if some characters are ambiguous"),
});

/** The "VIN camera scanner": read the VIN off a photo of the plate or windscreen sticker, then decode it. */
export async function scanVin(ctx: OrgContext, image: ImageInput) {
  const read = await runAi(ctx, "vin_scan", {
    system: "You read Vehicle Identification Numbers from photos. A VIN has 17 characters and never contains I, O or Q. Return null if no VIN is legible.",
    content: [imageBlock(image), { type: "text", text: "Read the VIN in this photo." }],
    schema: VinRead,
    effort: "low",
  });
  const candidates = [read.vin, ...read.alternatives].filter((v): v is string => !!v).map(normaliseVin);
  // Prefer a reading that passes the check digit.
  const best = candidates.find((v) => decodeVinLocally(v).checkDigitValid) ?? candidates[0] ?? null;
  return { vin: best, confidence: read.confidence, candidates, decode: best ? await decodeVin(best) : null };
}

// ------------------------------------------------------------------ listing writer

const Listing = z.object({
  title: z.string().describe("Max 70 chars, e.g. '2018 Toyota Camry SE – Tokunbo, Full Option'"),
  description: z.string().describe("3-5 short paragraphs, honest, no exaggeration, plain text"),
  highlights: z.array(z.string()).describe("4-8 bullet highlights"),
  tags: z.array(z.string()).describe("Search tags buyers would use"),
  whatsappMessage: z.string().describe("Short message buyers can send to enquire"),
});

/** Write the marketplace title, description and highlights for an inventory item. */
export async function writeListing(ctx: OrgContext, itemId: string, opts: { tone?: "professional" | "friendly" | "premium"; save?: boolean }) {
  const item = await one(pool, `SELECT * FROM inventory_items WHERE id = $1 AND org_id = $2`, [itemId, ctx.orgId]);
  if (!item) throw badRequest("Item not found");
  const photos = await many(pool, `SELECT url FROM item_photos WHERE item_id = $1 ORDER BY position LIMIT 4`, [itemId]);
  const images: ImageInput[] = [];
  for (const p of photos) images.push((await readStoredFile(p.url)) ?? { url: p.url });
  const facts = {
    kind: item.kind, title: item.title, make: item.make, model: item.model, year: item.year, trim: item.trim, color: item.color,
    mileageKm: item.mileage_km, transmission: item.transmission, fuel: item.fuel_type, engine: item.engine, condition: item.condition,
    bodyType: item.body_type, priceNgn: (item.asking_price_ngn ?? item.unit_price_ngn ?? 0) / 100, partNumber: item.part_number,
    brand: item.brand, compatibleWith: item.compatible_with, existingDescription: item.description, extra: item.attributes,
  };
  const output = await runAi(ctx, "listing_writer", {
    system: `${NIGERIA_CONTEXT} You write marketplace listings for greenrevs.com. Be accurate to the facts given; do not invent features, service history or accident status.`,
    content: [
      ...images.map(imageBlock),
      { type: "text", text: `Write a ${opts.tone ?? "professional"} listing for this item. Facts (JSON):\n${JSON.stringify(facts)}` },
    ],
    schema: Listing,
    effort: "low",
  });
  if (opts.save) {
    await pool.query(
      `UPDATE inventory_items SET title = $3, description = $4, attributes = attributes || jsonb_build_object('highlights', $5::jsonb, 'tags', $6::jsonb), updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [itemId, ctx.orgId, output.title, output.description, JSON.stringify(output.highlights), JSON.stringify(output.tags)],
    );
  }
  return output;
}

// ------------------------------------------------------------------ receipts & supplier invoices

const DocumentExtract = z.object({
  documentType: z.enum(["receipt", "supplier_invoice", "customs_duty_assessment", "shipping_bill", "other"]),
  supplierName: z.string().nullable(),
  supplierTin: z.string().nullable(),
  documentNumber: z.string().nullable(),
  date: z.string().nullable().describe("ISO date YYYY-MM-DD"),
  dueDate: z.string().nullable(),
  currency: z.string().describe("ISO code, e.g. NGN, USD"),
  lines: z.array(z.object({
    description: z.string(),
    quantity: z.number().nullable(),
    amount: z.number().describe("Line amount excluding VAT, in major units (e.g. naira, not kobo)"),
  })),
  vatAmount: z.number().nullable().describe("Major units"),
  total: z.number().describe("Major units"),
  vin: z.string().nullable().describe("VIN if the document refers to a specific vehicle"),
  suggestedCategory: z.enum(Object.keys(EXPENSE_CATEGORIES) as [string, ...string[]]),
  paid: z.boolean().describe("True if this is a receipt showing payment was made"),
});

/** Read a receipt / supplier invoice / customs assessment and propose an expense or bill. */
export async function extractDocument(ctx: OrgContext, file: ImageInput) {
  const doc = await runAi(ctx, "document_extract", {
    system: `${NIGERIA_CONTEXT} You read receipts, supplier invoices, Nigeria Customs duty assessments and shipping documents for bookkeeping. Use null when a field is not present.`,
    content: [imageBlock(file), { type: "text", text: "Extract this document for bookkeeping." }],
    schema: DocumentExtract,
    effort: "medium",
  });
  const toMinor = (n: number | null) => (n === null ? null : Math.round(n * 100));
  const supplier = doc.supplierName
    ? await one(pool, `SELECT id, name FROM contacts WHERE org_id = $1 AND kind IN ('supplier', 'both') AND name ILIKE $2 LIMIT 1`, [ctx.orgId, doc.supplierName])
    : null;
  const vehicle = doc.vin
    ? await one(pool, `SELECT id, title, status FROM inventory_items WHERE org_id = $1 AND vin = $2`, [ctx.orgId, normaliseVin(doc.vin)])
    : null;
  return {
    extracted: doc,
    matches: { supplier, vehicle },
    // Ready-to-post payloads (amounts in kobo) the app can show for confirmation.
    proposal: doc.paid
      ? {
          kind: "expense" as const,
          payload: {
            date: doc.date,
            category: doc.suggestedCategory,
            description: [doc.supplierName, doc.documentNumber].filter(Boolean).join(" ") || doc.lines[0]?.description || "Expense",
            amount: toMinor(doc.total - (doc.vatAmount ?? 0)),
            vat: toMinor(doc.vatAmount ?? 0),
            itemId: vehicle?.id,
            supplierId: supplier?.id,
          },
        }
      : {
          kind: "bill" as const,
          payload: {
            supplierId: supplier?.id,
            supplierRef: doc.documentNumber,
            billDate: doc.date,
            dueDate: doc.dueDate,
            currency: doc.currency,
            category: doc.suggestedCategory,
            lines: doc.lines.map((l) => ({ description: l.description, amount: toMinor(l.amount), itemId: vehicle?.id })),
          },
        },
  };
}

// ------------------------------------------------------------------ parts identification

const PartId = z.object({
  name: z.string(),
  category: z.string().describe("e.g. braking, suspension, engine, electrical, body, lighting, filters"),
  brand: z.string().nullable(),
  partNumber: z.string().nullable().describe("Only if printed/legible on the part or box"),
  oemOrAftermarket: z.enum(["oem", "aftermarket", "unknown"]),
  condition: z.enum(["brand_new", "foreign_used", "nigerian_used"]).nullable(),
  compatibleWith: z.array(z.string()).describe("Likely compatible vehicles, e.g. 'Toyota Corolla 2009-2013'"),
  suggestedTitle: z.string(),
  notes: z.string(),
});

/** Identify a spare part from photos for a parts vendor's catalogue; also suggests matching stock. */
export async function identifyPart(ctx: OrgContext, images: ImageInput[]) {
  if (images.length === 0) throw badRequest("Upload at least one photo");
  const part = await runAi(ctx, "part_identify", {
    system: `${NIGERIA_CONTEXT} You identify automotive spare parts from photos for a parts vendor's catalogue. Be conservative about compatibility and part numbers.`,
    content: [...images.map(imageBlock), { type: "text", text: "Identify this part." }],
    schema: PartId,
    effort: "medium",
  });
  const existing = await many(
    pool,
    `SELECT id, title, sku, part_number, quantity FROM inventory_items
      WHERE org_id = $1 AND kind <> 'vehicle' AND (($2::text IS NOT NULL AND part_number = $2) OR title ILIKE $3) LIMIT 5`,
    [ctx.orgId, part.partNumber, `%${part.name}%`],
  );
  return { part, existingMatches: existing };
}
