import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { migrationLogs } from "../database/schema/migration-logs";

type MigrationLog = typeof migrationLogs.$inferSelect;
type NewMigrationLog = typeof migrationLogs.$inferInsert;

@Injectable()
export class MigrationLogsRepository extends BaseRepository<
  typeof migrationLogs
> {
  protected readonly table = migrationLogs;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async createLog(data: NewMigrationLog): Promise<void> {
    await this.db.insert(migrationLogs).values(data as never);
  }

  async getStatusSummary(): Promise<{
    total: number;
    succeeded: number;
    failed: number;
  }> {
    const result = await this.db.execute(
      sql`SELECT COUNT(*)::int AS "total", COUNT(*) FILTER (WHERE status = 'succeeded')::int AS "succeeded", COUNT(*) FILTER (WHERE status = 'failed')::int AS "failed" FROM migration_logs`,
    );
    const row = result.rows[0] as
      | { total: number; succeeded: number; failed: number }
      | undefined;
    return row ?? { total: 0, succeeded: 0, failed: 0 };
  }

  async countByRunId(runId: string): Promise<number> {
    const result = await this.db.execute(
      sql`SELECT COUNT(*)::int AS "count" FROM migration_logs WHERE run_id = ${runId}`,
    );
    const row = result.rows[0] as { count: number } | undefined;
    return row?.count ?? 0;
  }

  async getResultsByRunId(runId: string): Promise<MigrationLog[]> {
    return this.db
      .select()
      .from(migrationLogs)
      .where(eq(migrationLogs.runId, runId));
  }

  async findLatestByMonolithCustomerId(
    monolithCustomerId: string,
  ): Promise<MigrationLog | null> {
    const [row] = await this.db
      .select()
      .from(migrationLogs)
      .where(eq(migrationLogs.monolithCustomerId, monolithCustomerId))
      .orderBy(desc(migrationLogs.createdAt))
      .limit(1);
    return row ?? null;
  }

  async getAggregateMigrationStats(): Promise<{
    migrated: number;
    failed: number;
  }> {
    const result = await this.db.execute(
      sql`SELECT
        COALESCE(SUM(CASE WHEN latest.status != 'failed' THEN 1 ELSE 0 END), 0)::int as "migrated",
        COALESCE(SUM(CASE WHEN latest.status = 'failed' THEN 1 ELSE 0 END), 0)::int as "failed"
      FROM (
        SELECT DISTINCT ON (monolith_customer_id) status
        FROM migration_logs
        WHERE script_name != 'dual_write_failure'
        ORDER BY monolith_customer_id, created_at DESC
      ) latest`,
    );
    const row = result.rows[0] as
      | { migrated: number; failed: number }
      | undefined;
    return row ?? { migrated: 0, failed: 0 };
  }
}
