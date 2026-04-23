import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { generateId } from "../../common/utils/uuid.util";

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    stripeEventId: text("stripe_event_id").notNull(),
    eventType: text("event_type").notNull(),
    gatewayProvider: text("gateway_provider").notNull().default("stripe"),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("received"),
    customerId: text("customer_id"),
    chargeId: text("charge_id"),
    invoiceId: text("invoice_id"),
    errorMessage: text("error_message"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_webhook_events_stripe_event_id").on(table.stripeEventId),
    index("idx_webhook_events_customer_id").on(table.customerId),
  ],
);
