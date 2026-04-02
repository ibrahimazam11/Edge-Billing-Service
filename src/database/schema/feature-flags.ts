import {
  pgTable,
  uuid,
  varchar,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    flagName: varchar("flag_name", { length: 255 }).notNull(),
    enabled: boolean("enabled").notNull().default(false),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_feature_flags_customer_flag").on(
      table.customerId,
      table.flagName,
    ),
    index("idx_feature_flags_customer_id").on(table.customerId),
    index("idx_feature_flags_flag_name_enabled").on(
      table.flagName,
      table.enabled,
    ),
  ],
);
