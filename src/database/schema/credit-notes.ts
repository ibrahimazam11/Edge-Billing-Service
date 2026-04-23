import {
  pgTable,
  uuid,
  varchar,
  integer,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { invoices } from "./invoices";

export const creditNotes = pgTable(
  "credit_notes",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("usd"),
    reason: text("reason").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("issued"),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_credit_notes_customer_id").on(table.customerId),
    index("idx_credit_notes_invoice_id").on(table.invoiceId),
  ],
);
