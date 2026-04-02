import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";

export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    stripePaymentMethodId: text("stripe_payment_method_id").notNull(),
    type: varchar("type", { length: 20 }).notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    lastFour: varchar("last_four", { length: 4 }),
    brand: varchar("brand", { length: 50 }),
    bankName: varchar("bank_name", { length: 255 }),
    expiryMonth: integer("expiry_month"),
    expiryYear: integer("expiry_year"),
    metadata: jsonb("metadata"),
    fallbackOrder: integer("fallback_order"),
    gatewayProvider: text("gateway_provider").notNull().default("stripe"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_payment_methods_customer_id").on(table.customerId),
    uniqueIndex("idx_payment_methods_stripe_payment_method_id").on(
      table.stripePaymentMethodId,
    ),
    index("idx_payment_methods_gateway_provider").on(table.gatewayProvider),
  ],
);
