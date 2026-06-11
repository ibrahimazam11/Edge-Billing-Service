/**
 * Converts a decimal-string monetary value to integer cents.
 *
 * P3: This helper MUST throw on non-numeric input (e.g. `"abc"`, `"1,234.56"`,
 * `undefined`). The previous implementation silently returned 0 which masked
 * upstream data quality issues. Each writer that uses this function wraps the
 * call in a try/catch and surfaces a `{status:'failed'}` step result.
 */
export function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    throw new Error(`toCents: value is null/undefined`);
  }
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || Number.isNaN(num) || !Number.isFinite(num)) {
    throw new Error(`toCents: non-numeric value: ${String(value)}`);
  }
  return Math.round(num * 100);
}

/**
 * Safer variant: returns null on null/undefined input but still throws on
 * non-numeric strings. Useful for optional fields like `creditCardSurcharge`.
 */
export function toCentsOrNull(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  return toCents(value);
}

export type StepResult =
  | {
      status: "succeeded";
      data?: Record<string, unknown>;
      dryRun?: boolean;
      planned?: Record<string, unknown>;
    }
  | { status: "skipped"; reason: string; data?: Record<string, unknown> }
  | { status: "failed"; reason: string; error?: string };

export const DRY_RUN_PLACEHOLDER_ID = "<dry-run>";
