import {
  pgTable,
  uuid,
  text,
  varchar,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey(),
    monolithCustomerId: text("monolith_customer_id").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    name: text("name").notNull(),
    email: text("email").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_customers_monolith_customer_id").on(
      table.monolithCustomerId,
    ),
    index("idx_customers_stripe_customer_id").on(table.stripeCustomerId),
  ],
);
