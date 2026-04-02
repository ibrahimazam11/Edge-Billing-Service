import {
  pgTable,
  pgEnum,
  uuid,
  boolean,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";

export const surchargeTypeEnum = pgEnum("surcharge_type", [
  "percentage",
  "flat_fee",
]);

export const surchargeConfigs = pgTable(
  "surcharge_configs",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    allowCreditCard: boolean("allow_credit_card").notNull().default(false),
    surchargeType: surchargeTypeEnum("surcharge_type"),
    surchargeValue: integer("surcharge_value"),
    reason: text("reason"),
    notes: text("notes"),
    enabledBy: text("enabled_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_surcharge_configs_customer_id").on(table.customerId),
  ],
);
