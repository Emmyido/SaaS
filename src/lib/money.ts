/**
 * All money is stored as integer minor units (kobo for NGN, cents for USD/GBP/EUR).
 * The API accepts and returns minor units too, so clients never deal with float rounding.
 */

/** Round half away from zero to an integer number of minor units. */
export function roundMinor(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Convert a foreign amount (minor units) to NGN minor units at a rate of NGN per 1 unit of foreign currency. */
export function toNgn(foreignMinor: number, fxRate: number): number {
  return roundMinor(foreignMinor * fxRate);
}

/** VAT on a net amount, with the rate in basis points (750 = 7.5%). */
export function vatOn(netMinor: number, rateBp: number): number {
  return roundMinor((netMinor * rateBp) / 10000);
}

/**
 * Split `total` across `weights` proportionally so the parts sum exactly to `total`
 * (largest-remainder method). Used to spread invoice-level discounts over lines.
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (total * w) / sum);
  const floored = raw.map((r) => Math.floor(r));
  let remainder = total - floored.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) floored[order[k].i] += 1;
  return floored;
}

export const SUPPORTED_CURRENCIES = ["NGN", "USD", "GBP", "EUR", "CAD", "AED", "JPY", "CNY"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];
