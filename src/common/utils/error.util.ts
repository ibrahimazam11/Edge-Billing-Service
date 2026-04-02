/**
 * Checks if an error is a PostgreSQL unique constraint violation (23505).
 * Handles both direct PG errors and drizzle-orm wrapped errors where
 * the original PG error is on error.cause.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code === "23505" || e.cause?.code === "23505";
  }
  return false;
}
