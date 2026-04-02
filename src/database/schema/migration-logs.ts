import {
  pgTable,
  uuid,
  text,
  varchar,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const migrationLogs = pgTable(
  "migration_logs",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id").notNull(),
    scriptName: varchar("script_name", { length: 255 }).notNull(),
    monolithCustomerId: varchar("monolith_customer_id", {
      length: 255,
    }).notNull(),
    billingCustomerId: uuid("billing_customer_id"),
    status: varchar("status", { length: 20 }).notNull(),
    errorMessage: text("error_message"),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_migration_logs_run_id").on(table.runId),
    index("idx_migration_logs_monolith_customer_id").on(
      table.monolithCustomerId,
    ),
  ],
);
