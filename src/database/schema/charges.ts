import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { invoices } from "./invoices";
import { paymentMethods } from "./payment-methods";

export const charges = pgTable(
  "charges",
  {
    id: uuid("id").primaryKey(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    paymentMethodId: uuid("payment_method_id")
      .notNull()
      .references(() => paymentMethods.id),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("usd"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    failureReason: text("failure_reason"),
    attemptNumber: integer("attempt_number").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_charges_invoice_id").on(table.invoiceId),
    index("idx_charges_customer_id").on(table.customerId),
    uniqueIndex("idx_charges_idempotency_key").on(table.idempotencyKey),
    index("idx_charges_stripe_payment_intent_id").on(
      table.stripePaymentIntentId,
    ),
  ],
);
