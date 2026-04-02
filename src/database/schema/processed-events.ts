import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";

export const processedEvents = pgTable(
  "processed_events",
  {
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.eventType] })],
);
