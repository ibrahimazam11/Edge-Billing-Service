import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase, TransactionClient } from "../database/types";
import { reconciliationRuns } from "../database/schema/reconciliation-runs";

type ReconciliationRun = typeof reconciliationRuns.$inferSelect;
type NewReconciliationRun = typeof reconciliationRuns.$inferInsert;

@Injectable()
export class ReconciliationRunsRepository extends BaseRepository<
  typeof reconciliationRuns
> {
  protected readonly table = reconciliationRuns;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async findExistingRun(
    periodStart: Date,
    periodEnd: Date,
  ): Promise<ReconciliationRun | undefined> {
    const results = await this.db
      .select()
      .from(reconciliationRuns)
      .where(
        and(
          eq(reconciliationRuns.periodStart, periodStart),
          eq(reconciliationRuns.periodEnd, periodEnd),
          inArray(reconciliationRuns.status, ["balanced", "discrepancy_found"]),
        ),
      )
      .limit(1);
    return results[0];
  }

  async createInTx(
    data: NewReconciliationRun,
    tx: TransactionClient,
  ): Promise<void> {
    await this.conn(tx)
      .insert(reconciliationRuns as never)
      .values(data as never);
  }

  async createFailed(data: NewReconciliationRun): Promise<void> {
    await this.db.insert(reconciliationRuns).values(data as never);
  }

  async findByDateRange(
    filters: {
      status?: string;
      startDate?: string;
      endDate?: string;
      cursor?: string;
    },
    limit: number,
  ): Promise<ReconciliationRun[]> {
    const conditions: SQL[] = [];

    if (filters.status) {
      conditions.push(
        eq(
          reconciliationRuns.status,
          filters.status as "balanced" | "discrepancy_found" | "failed",
        ),
      );
    }
    if (filters.startDate) {
      conditions.push(
        gte(reconciliationRuns.periodStart, new Date(filters.startDate)),
      );
    }
    if (filters.endDate) {
      conditions.push(
        lt(reconciliationRuns.periodStart, new Date(filters.endDate)),
      );
    }
    if (filters.cursor) {
      conditions.push(lt(reconciliationRuns.id, filters.cursor));
    }

    return this.db
      .select()
      .from(reconciliationRuns)
      .where(this.buildWhereClause(conditions))
      .orderBy(desc(reconciliationRuns.id))
      .limit(limit + 1);
  }

  async getLatestRunStatus(): Promise<string | null> {
    const result = await this.db.execute(
      sql`SELECT status FROM reconciliation_runs ORDER BY created_at DESC LIMIT 1`,
    );
    const row = result.rows[0] as { status: string } | undefined;
    return row?.status ?? null;
  }
}
