import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";

export const creditBalances = pgTable(
  "credit_balances",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    balanceCents: integer("balance_cents").notNull().default(0),
    currency: varchar("currency", { length: 3 }).notNull().default("usd"),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_credit_balances_customer_id").on(table.customerId),
  ],
);
