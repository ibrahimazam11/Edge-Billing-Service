import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    planName: text("plan_name").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("usd"),
    billingInterval: varchar("billing_interval", { length: 20 })
      .notNull()
      .default("monthly"),
    billingPeriodStart: timestamp("billing_period_start", {
      withTimezone: true,
    }).notNull(),
    billingPeriodEnd: timestamp("billing_period_end", {
      withTimezone: true,
    }).notNull(),
    nextBillingDate: timestamp("next_billing_date", {
      withTimezone: true,
    }),
    stripeSubscriptionId: text("stripe_subscription_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_subscriptions_customer_id").on(table.customerId),
    index("idx_subscriptions_status").on(table.status),
    index("idx_subscriptions_next_billing_date").on(table.nextBillingDate),
  ],
);
