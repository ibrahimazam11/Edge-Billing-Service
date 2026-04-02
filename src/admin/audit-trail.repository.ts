import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, lt, type SQL } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { auditTrail } from "../database/schema/audit-trail";

type AuditTrailEntry = typeof auditTrail.$inferSelect;

@Injectable()
export class AuditTrailRepository extends BaseRepository<typeof auditTrail> {
  protected readonly table = auditTrail;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async search(
    filters: {
      entityType?: string;
      entityId?: string;
      adminUserId?: string;
      startDate?: string;
      endDate?: string;
      cursor?: string;
    },
    limit: number,
  ): Promise<AuditTrailEntry[]> {
    const conditions: SQL[] = [];

    if (filters.entityType) {
      conditions.push(eq(auditTrail.entityType, filters.entityType));
    }
    if (filters.entityId) {
      conditions.push(eq(auditTrail.entityId, filters.entityId));
    }
    if (filters.adminUserId) {
      conditions.push(eq(auditTrail.adminUserId, filters.adminUserId));
    }

    conditions.push(
      ...this.buildDateRangeConditions(
        auditTrail.createdAt,
        filters.startDate,
        filters.endDate,
      ),
    );

    if (filters.cursor) {
      conditions.push(lt(auditTrail.id, filters.cursor));
    }

    return this.db
      .select()
      .from(auditTrail)
      .where(this.buildWhereClause(conditions))
      .orderBy(desc(auditTrail.id))
      .limit(limit + 1) as Promise<AuditTrailEntry[]>;
  }
}
