/**
 * VIN helpers (ISO 3779). Works offline: validates the check digit, decodes the model year and
 * recognises the manufacturer from the WMI for the makes most common in the Nigerian market.
 */

const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789";

export function normaliseVin(vin: string): string {
  return vin.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/[IQ]/g, (c) => (c === "I" ? "1" : "0"));
}

export function isWellFormedVin(vin: string): boolean {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

export function checkDigitValid(vin: string): boolean {
  if (!isWellFormedVin(vin)) return false;
  let total = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i];
    const v = /\d/.test(c) ? Number(c) : TRANSLIT[c];
    total += v * WEIGHTS[i];
  }
  const rem = total % 11;
  return vin[8] === (rem === 10 ? "X" : String(rem));
}

/**
 * Model year from position 10. The code repeats every 30 years. North American VINs (WMI starting 1-5)
 * mark 2010+ with a letter in position 7; for other regions we take the most recent plausible year.
 */
export function decodeYear(vin: string): number | null {
  const idx = YEAR_CODES.indexOf(vin[9]);
  if (idx < 0) return null;
  const base = 1980 + idx;
  const maxYear = new Date().getUTCFullYear() + 1;
  if (/^[1-5]/.test(vin)) return /[A-Z]/.test(vin[6]) ? base + 30 : base;
  return base + 30 <= maxYear ? base + 30 : base;
}

const WMI: Array<[string, string, string]> = [
  // prefix, make, country of manufacture
  ["JTH", "Lexus", "Japan"], ["JTJ", "Lexus", "Japan"], ["2T2", "Lexus", "Canada"], ["58A", "Lexus", "USA"],
  ["JT", "Toyota", "Japan"], ["4T", "Toyota", "USA"], ["5T", "Toyota", "USA"], ["2T", "Toyota", "Canada"], ["MR0", "Toyota", "Thailand"], ["AHT", "Toyota", "South Africa"],
  ["JHM", "Honda", "Japan"], ["1HG", "Honda", "USA"], ["2HG", "Honda", "Canada"], ["5FN", "Honda", "USA"], ["5J6", "Honda", "USA"], ["19X", "Honda", "USA"],
  ["19U", "Acura", "USA"], ["JH4", "Acura", "Japan"], ["5J8", "Acura", "USA"],
  ["WDD", "Mercedes-Benz", "Germany"], ["WDB", "Mercedes-Benz", "Germany"], ["WDC", "Mercedes-Benz", "Germany"], ["W1K", "Mercedes-Benz", "Germany"],
  ["W1N", "Mercedes-Benz", "Germany"], ["4JG", "Mercedes-Benz", "USA"], ["55S", "Mercedes-Benz", "USA"],
  ["WBA", "BMW", "Germany"], ["WBS", "BMW M", "Germany"], ["5UX", "BMW", "USA"], ["5YM", "BMW", "USA"],
  ["WAU", "Audi", "Germany"], ["WA1", "Audi", "Germany"], ["WVW", "Volkswagen", "Germany"], ["WVG", "Volkswagen", "Germany"], ["3VW", "Volkswagen", "Mexico"],
  ["1FA", "Ford", "USA"], ["1FT", "Ford", "USA"], ["1FM", "Ford", "USA"], ["2FM", "Ford", "Canada"], ["3FA", "Ford", "Mexico"],
  ["1G1", "Chevrolet", "USA"], ["1GN", "Chevrolet", "USA"], ["1GC", "Chevrolet", "USA"], ["1GK", "GMC", "USA"], ["1GY", "Cadillac", "USA"],
  ["1C4", "Jeep / Chrysler", "USA"], ["1J4", "Jeep", "USA"], ["2C3", "Chrysler / Dodge", "Canada"], ["1D7", "Dodge", "USA"],
  ["KMH", "Hyundai", "South Korea"], ["5NP", "Hyundai", "USA"], ["5NM", "Hyundai", "USA"], ["KM8", "Hyundai", "South Korea"],
  ["KNA", "Kia", "South Korea"], ["KND", "Kia", "South Korea"], ["5XY", "Kia", "USA"], ["5XX", "Kia", "USA"],
  ["JN1", "Nissan", "Japan"], ["JN8", "Nissan", "Japan"], ["1N4", "Nissan", "USA"], ["1N6", "Nissan", "USA"], ["5N1", "Nissan", "USA"], ["3N1", "Nissan", "Mexico"],
  ["JNK", "Infiniti", "Japan"], ["5N3", "Infiniti", "USA"],
  ["JM1", "Mazda", "Japan"], ["JM3", "Mazda", "Japan"], ["JA3", "Mitsubishi", "Japan"], ["JA4", "Mitsubishi", "Japan"], ["ML3", "Mitsubishi", "Thailand"],
  ["JF1", "Subaru", "Japan"], ["JF2", "Subaru", "Japan"], ["4S4", "Subaru", "USA"], ["JS", "Suzuki", "Japan"], ["MA3", "Suzuki", "India"],
  ["VF3", "Peugeot", "France"], ["VF1", "Renault", "France"], ["VF7", "Citroën", "France"],
  ["SAL", "Land Rover", "UK"], ["SAJ", "Jaguar", "UK"], ["YV1", "Volvo", "Sweden"], ["YV4", "Volvo", "Sweden"], ["WP0", "Porsche", "Germany"], ["WP1", "Porsche", "Germany"],
  ["LVS", "Ford (China)", "China"], ["LSG", "GM (China)", "China"], ["LGW", "GWM / Haval", "China"], ["LB3", "Geely", "China"], ["LS5", "Changan", "China"], ["LVV", "Chery", "China"],
];

export interface LocalVinDecode {
  vin: string;
  wellFormed: boolean;
  checkDigitValid: boolean;
  make: string | null;
  country: string | null;
  modelYear: number | null;
}

export function decodeVinLocally(raw: string): LocalVinDecode {
  const vin = normaliseVin(raw);
  const wellFormed = isWellFormedVin(vin);
  const match = WMI.find(([prefix]) => vin.startsWith(prefix));
  return {
    vin,
    wellFormed,
    // Check digits are mandatory for North American VINs only; others are often valid without one.
    checkDigitValid: wellFormed && checkDigitValid(vin),
    make: match?.[1] ?? null,
    country: match?.[2] ?? null,
    modelYear: wellFormed ? decodeYear(vin) : null,
  };
}
