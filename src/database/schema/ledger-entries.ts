import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { ledgerAccounts } from "./ledger-accounts";

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey(),
    debitAccountId: uuid("debit_account_id")
      .notNull()
      .references(() => ledgerAccounts.id),
    creditAccountId: uuid("credit_account_id")
      .notNull()
      .references(() => ledgerAccounts.id),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("usd"),
    referenceType: varchar("reference_type", { length: 20 }).notNull(),
    referenceId: uuid("reference_id").notNull(),
    description: text("description"),
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_ledger_entries_reference").on(
      table.referenceType,
      table.referenceId,
    ),
    index("idx_ledger_entries_created_at").on(table.createdAt),
    index("idx_ledger_entries_ref_type_created").on(
      table.referenceType,
      table.createdAt,
    ),
  ],
);
