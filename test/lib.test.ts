import { describe, expect, it } from "vitest";
import { allocate, toNgn, vatOn } from "../src/lib/money.js";
import { addMonths } from "../src/lib/dates.js";
import { checkDigitValid, decodeVinLocally, normaliseVin } from "../src/lib/vin.js";

describe("money", () => {
  it("allocates exactly, largest remainder first", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1000, [700, 300])).toEqual([700, 300]);
    expect(allocate(7, [0, 0])).toEqual([7, 0]);
    const parts = allocate(2_450_000_00, [1, 1, 1, 1, 1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(2_450_000_00);
  });

  it("computes VAT and FX in minor units", () => {
    expect(vatOn(4_700_000, 750)).toBe(352_500);
    expect(vatOn(1, 750)).toBe(0);
    expect(toNgn(1_000_000, 1500)).toBe(1_500_000_000); // $10,000.00 at ₦1,500
    expect(toNgn(333, 1612.555)).toBe(536_981);
  });

  it("adds months clamping to month end", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
  });
});

describe("vin", () => {
  it("validates the ISO 3779 check digit", () => {
    expect(checkDigitValid("1HGCM82633A004352")).toBe(true);
    expect(checkDigitValid("1HGCM82634A004352")).toBe(false);
  });

  it("normalises OCR look-alikes", () => {
    expect(normaliseVin("1hgcm 8263-3a0o4352")).toBe("1HGCM82633A004352");
  });

  it("decodes make, country and model year offline", () => {
    const d = decodeVinLocally("1HGCM82633A004352");
    expect(d).toMatchObject({ make: "Honda", country: "USA", modelYear: 2003, checkDigitValid: true });
    expect(decodeVinLocally("4T1BF1FK5CU123456").modelYear).toBe(2012);
    expect(decodeVinLocally("JTDKN3DU0A0123456").make).toBe("Toyota");
    expect(decodeVinLocally("JTHBK1GG0F2123456").make).toBe("Lexus");
  });
});
