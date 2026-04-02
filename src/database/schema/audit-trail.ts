import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const auditTrail = pgTable(
  "audit_trail",
  {
    id: uuid("id").primaryKey(),
    adminUserId: text("admin_user_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_audit_trail_admin_user_id").on(table.adminUserId),
    index("idx_audit_trail_entity").on(table.entityType, table.entityId),
    index("idx_audit_trail_created_at").on(table.createdAt),
  ],
);
