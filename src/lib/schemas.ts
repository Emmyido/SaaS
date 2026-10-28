import { z } from "zod";

export const kobo = z.number().int().nonnegative().describe("Amount in kobo (minor units). ₦1,000 = 100000");
export const positiveKobo = z.number().int().positive().describe("Amount in kobo (minor units)");
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const uuid = z.string().uuid();
export const idParams = z.object({ id: uuid });
export const rateBp = z.number().int().min(0).max(10000).describe("Basis points: 750 = 7.5%");
export const currency = z.enum(["NGN", "USD", "GBP", "EUR", "CAD", "AED", "JPY", "CNY"]);
export const method = z.enum(["cash", "transfer", "pos", "cheque", "card"]);
export const range = z.object({ from: isoDate, to: isoDate });
export const paging = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() });
