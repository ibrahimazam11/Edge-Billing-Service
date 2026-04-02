import {
  pgTable,
  uuid,
  varchar,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { subscriptions } from "./subscriptions";

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    totalAmountCents: integer("total_amount_cents").notNull().default(0),
    currency: varchar("currency", { length: 3 }).notNull().default("usd"),
    billingPeriodStart: timestamp("billing_period_start", {
      withTimezone: true,
    }).notNull(),
    billingPeriodEnd: timestamp("billing_period_end", {
      withTimezone: true,
    }).notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_invoices_customer_id").on(table.customerId),
    index("idx_invoices_status").on(table.status),
    index("idx_invoices_subscription_id").on(table.subscriptionId),
    index("idx_invoices_due_date").on(table.dueDate),
    index("idx_invoices_created_at").on(table.createdAt),
  ],
);
