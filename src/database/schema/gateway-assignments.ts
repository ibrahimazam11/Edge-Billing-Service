import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";

export const gatewayAssignments = pgTable(
  "gateway_assignments",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    gatewayProvider: text("gateway_provider").notNull(),
    gatewayCustomerId: text("gateway_customer_id").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_gateway_assignments_customer_gateway").on(
      table.customerId,
      table.gatewayProvider,
    ),
    index("idx_gateway_assignments_customer_id").on(table.customerId),
    index("idx_gateway_assignments_gateway_provider").on(table.gatewayProvider),
  ],
);
