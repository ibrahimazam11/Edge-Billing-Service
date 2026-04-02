import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { invoices } from "./invoices";
import { charges } from "./charges";
import { paymentMethods } from "./payment-methods";

export const dunningAttempts = pgTable(
  "dunning_attempts",
  {
    id: uuid("id").primaryKey(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    chargeId: uuid("charge_id").references(() => charges.id),
    attemptNumber: integer("attempt_number").notNull(),
    scheduledDate: timestamp("scheduled_date", {
      withTimezone: true,
    }).notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    status: text("status").notNull().default("scheduled"),
    paymentMethodId: uuid("payment_method_id").references(
      () => paymentMethods.id,
    ),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_dunning_attempts_invoice_id").on(table.invoiceId),
    index("idx_dunning_attempts_status_scheduled_date").on(
      table.status,
      table.scheduledDate,
    ),
    index("idx_dunning_attempts_payment_method_id").on(table.paymentMethodId),
    index("idx_dunning_attempts_created_at").on(table.createdAt),
  ],
);
