import { toCents, toCentsOrNull } from "./helpers";

describe("helpers.toCents (P3)", () => {
  it("converts decimal strings to cents", () => {
    expect(toCents("1.23")).toBe(123);
    expect(toCents("100")).toBe(10000);
    expect(toCents("0.01")).toBe(1);
  });

  it("throws on non-numeric input (P3 — must not silently return 0)", () => {
    expect(() => toCents("abc")).toThrow(/non-numeric/);
    expect(() => toCents("1,234.56")).toThrow(/non-numeric/);
  });

  it("throws on null/undefined", () => {
    expect(() => toCents(null)).toThrow();
    expect(() => toCents(undefined)).toThrow();
  });

  it("toCentsOrNull returns null on null/undefined but throws on bad string", () => {
    expect(toCentsOrNull(null)).toBeNull();
    expect(toCentsOrNull(undefined)).toBeNull();
    expect(() => toCentsOrNull("abc")).toThrow();
    expect(toCentsOrNull("5.00")).toBe(500);
  });
});
