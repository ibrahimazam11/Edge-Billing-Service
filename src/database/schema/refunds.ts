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
import { charges } from "./charges";
import { invoices } from "./invoices";
import { customers } from "./customers";

export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey(),
    chargeId: uuid("charge_id")
      .notNull()
      .references(() => charges.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("usd"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    reason: text("reason"),
    idempotencyKey: text("idempotency_key").notNull(),
    gatewayRefundId: text("gateway_refund_id"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_refunds_charge_id").on(table.chargeId),
    index("idx_refunds_customer_id").on(table.customerId),
    uniqueIndex("idx_refunds_idempotency_key").on(table.idempotencyKey),
    index("idx_refunds_gateway_refund_id").on(table.gatewayRefundId),
  ],
);
