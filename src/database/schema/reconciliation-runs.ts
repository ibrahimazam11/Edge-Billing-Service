import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";

export const reconciliationStatusEnum = pgEnum("reconciliation_status", [
  "balanced",
  "discrepancy_found",
  "failed",
]);

export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: uuid("id").primaryKey(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    status: reconciliationStatusEnum("status").notNull(),
    recordsCompared: integer("records_compared").notNull(),
    totalInternalAmountCents: bigint("total_internal_amount_cents", {
      mode: "number",
    }).notNull(),
    totalStripeAmountCents: bigint("total_stripe_amount_cents", {
      mode: "number",
    }).notNull(),
    errorReason: text("error_reason"),
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_reconciliation_runs_period").on(
      table.periodStart,
      table.periodEnd,
    ),
    index("idx_reconciliation_runs_status").on(table.status),
  ],
);
