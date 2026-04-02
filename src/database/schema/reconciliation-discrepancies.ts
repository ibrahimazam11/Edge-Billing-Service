import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import { reconciliationRuns } from "./reconciliation-runs";

export const discrepancyTypeEnum = pgEnum("discrepancy_type", [
  "missing_internal",
  "missing_stripe",
  "amount_mismatch",
]);

export const reconciliationDiscrepancies = pgTable(
  "reconciliation_discrepancies",
  {
    id: uuid("id").primaryKey(),
    reconciliationRunId: uuid("reconciliation_run_id")
      .notNull()
      .references(() => reconciliationRuns.id),
    type: discrepancyTypeEnum("type").notNull(),
    internalReferenceId: text("internal_reference_id"),
    stripeTransactionId: text("stripe_transaction_id"),
    expectedAmountCents: bigint("expected_amount_cents", {
      mode: "number",
    }).notNull(),
    actualAmountCents: bigint("actual_amount_cents", {
      mode: "number",
    }).notNull(),
    differenceCents: bigint("difference_cents", {
      mode: "number",
    }).notNull(),
    disputeStatus: text("dispute_status").notNull().default("open"),
    resolvedBy: text("resolved_by"),
    resolutionNotes: text("resolution_notes"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_reconciliation_discrepancies_run_id").on(
      table.reconciliationRunId,
    ),
    index("idx_reconciliation_discrepancies_dispute_status").on(
      table.disputeStatus,
    ),
  ],
);
