import { isDuplicateKeyError } from "./error.util";

describe("isDuplicateKeyError", () => {
  it("should return true for direct PG error with code 23505", () => {
    const error = Object.assign(new Error("unique_violation"), {
      code: "23505",
    });
    expect(isDuplicateKeyError(error)).toBe(true);
  });

  it("should return true for drizzle-orm wrapped error with cause.code 23505", () => {
    const error = new Error("Failed query: INSERT INTO ...");
    Object.defineProperty(error, "cause", { value: { code: "23505" } });
    expect(isDuplicateKeyError(error)).toBe(true);
  });

  it("should return false for non-duplicate-key errors", () => {
    expect(isDuplicateKeyError(new Error("some other error"))).toBe(false);
  });

  it("should return false for null", () => {
    expect(isDuplicateKeyError(null)).toBe(false);
  });

  it("should return false for non-object values", () => {
    expect(isDuplicateKeyError("string error")).toBe(false);
    expect(isDuplicateKeyError(42)).toBe(false);
    expect(isDuplicateKeyError(undefined)).toBe(false);
  });

  it("should return false for objects with different error codes", () => {
    const error = Object.assign(new Error("foreign_key_violation"), {
      code: "23503",
    });
    expect(isDuplicateKeyError(error)).toBe(false);
  });
});
