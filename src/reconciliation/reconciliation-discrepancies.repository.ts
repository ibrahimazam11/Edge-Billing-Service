import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase, TransactionClient } from "../database/types";
import { reconciliationDiscrepancies } from "../database/schema/reconciliation-discrepancies";
import { reconciliationRuns } from "../database/schema/reconciliation-runs";

type ReconciliationDiscrepancy =
  typeof reconciliationDiscrepancies.$inferSelect;
type NewDiscrepancy = typeof reconciliationDiscrepancies.$inferInsert;

export type DiscrepancyWithRunDetails = {
  id: string;
  reconciliationRunId: string;
  type: string;
  internalReferenceId: string | null;
  stripeTransactionId: string | null;
  expectedAmountCents: number;
  actualAmountCents: number;
  differenceCents: number;
  disputeStatus: string;
  resolvedBy: string | null;
  resolutionNotes: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
};

@Injectable()
export class ReconciliationDiscrepanciesRepository extends BaseRepository<
  typeof reconciliationDiscrepancies
> {
  protected readonly table = reconciliationDiscrepancies;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  private selectWithRunDetails() {
    return {
      id: reconciliationDiscrepancies.id,
      reconciliationRunId: reconciliationDiscrepancies.reconciliationRunId,
      type: reconciliationDiscrepancies.type,
      internalReferenceId: reconciliationDiscrepancies.internalReferenceId,
      stripeTransactionId: reconciliationDiscrepancies.stripeTransactionId,
      expectedAmountCents: reconciliationDiscrepancies.expectedAmountCents,
      actualAmountCents: reconciliationDiscrepancies.actualAmountCents,
      differenceCents: reconciliationDiscrepancies.differenceCents,
      disputeStatus: reconciliationDiscrepancies.disputeStatus,
      resolvedBy: reconciliationDiscrepancies.resolvedBy,
      resolutionNotes: reconciliationDiscrepancies.resolutionNotes,
      resolvedAt: reconciliationDiscrepancies.resolvedAt,
      createdAt: reconciliationDiscrepancies.createdAt,
      periodStart: reconciliationRuns.periodStart,
      periodEnd: reconciliationRuns.periodEnd,
    };
  }

  async findWithRunDetails(
    id: string,
  ): Promise<DiscrepancyWithRunDetails | null> {
    const [row] = await this.db
      .select(this.selectWithRunDetails())
      .from(reconciliationDiscrepancies)
      .leftJoin(
        reconciliationRuns,
        eq(
          reconciliationDiscrepancies.reconciliationRunId,
          reconciliationRuns.id,
        ),
      )
      .where(eq(reconciliationDiscrepancies.id, id))
      .limit(1);
    // SAFETY: columns match DiscrepancyWithRunDetails by construction via selectWithRunDetails()
    return (row as DiscrepancyWithRunDetails) ?? null;
  }

  /**
   * Fetches `limit + 1` rows to enable cursor-based "has more" pagination.
   * Callers should check `results.length > limit` to determine if more rows exist.
   */
  async search(
    filters: {
      disputeStatus?: string;
      runId?: string;
      dateFrom?: string;
      dateTo?: string;
      cursor?: string;
    },
    limit: number,
  ): Promise<DiscrepancyWithRunDetails[]> {
    const conditions: SQL[] = [];

    if (filters.disputeStatus) {
      conditions.push(
        eq(reconciliationDiscrepancies.disputeStatus, filters.disputeStatus),
      );
    }
    if (filters.runId) {
      conditions.push(
        eq(reconciliationDiscrepancies.reconciliationRunId, filters.runId),
      );
    }

    conditions.push(
      ...this.buildDateRangeConditions(
        reconciliationDiscrepancies.createdAt,
        filters.dateFrom,
        filters.dateTo,
      ),
    );

    if (filters.cursor) {
      conditions.push(lt(reconciliationDiscrepancies.id, filters.cursor));
    }

    return (
      this.db
        .select(this.selectWithRunDetails())
        .from(reconciliationDiscrepancies)
        .leftJoin(
          reconciliationRuns,
          eq(
            reconciliationDiscrepancies.reconciliationRunId,
            reconciliationRuns.id,
          ),
        )
        .where(this.buildWhereClause(conditions))
        .orderBy(desc(reconciliationDiscrepancies.id))
        // SAFETY: columns match DiscrepancyWithRunDetails by construction via selectWithRunDetails()
        .limit(limit + 1) as Promise<DiscrepancyWithRunDetails[]>
    );
  }

  async findByRunIds(runIds: string[]): Promise<ReconciliationDiscrepancy[]> {
    if (runIds.length === 0) return [];
    return this.db
      .select()
      .from(reconciliationDiscrepancies)
      .where(inArray(reconciliationDiscrepancies.reconciliationRunId, runIds));
  }

  async insertBatch(
    discrepancies: NewDiscrepancy[],
    tx?: TransactionClient,
  ): Promise<void> {
    if (discrepancies.length === 0) return;
    await this.conn(tx)
      .insert(reconciliationDiscrepancies)
      .values(discrepancies);
  }

  async updateDisputeStatus(
    id: string,
    status: string,
  ): Promise<{ id: string } | null> {
    const [updated] = await this.db
      .update(reconciliationDiscrepancies)
      .set({ disputeStatus: status })
      .where(eq(reconciliationDiscrepancies.id, id))
      .returning({ id: reconciliationDiscrepancies.id });
    return updated ?? null;
  }

  async resolve(
    id: string,
    resolution: { resolvedBy: string; resolutionNotes: string },
  ): Promise<{ id: string } | null> {
    const [updated] = await this.db
      .update(reconciliationDiscrepancies)
      .set({
        disputeStatus: "resolved",
        resolvedBy: resolution.resolvedBy,
        resolutionNotes: resolution.resolutionNotes,
        resolvedAt: new Date(),
      })
      .where(eq(reconciliationDiscrepancies.id, id))
      .returning({ id: reconciliationDiscrepancies.id });
    return updated ?? null;
  }

  async exportByDateRange(
    from: string,
    to: string,
  ): Promise<DiscrepancyWithRunDetails[]> {
    const conditions: SQL[] = this.buildDateRangeConditions(
      reconciliationDiscrepancies.createdAt,
      from,
      to,
    );

    return (
      this.db
        .select(this.selectWithRunDetails())
        .from(reconciliationDiscrepancies)
        .leftJoin(
          reconciliationRuns,
          eq(
            reconciliationDiscrepancies.reconciliationRunId,
            reconciliationRuns.id,
          ),
        )
        .where(and(...conditions))
        // SAFETY: columns match DiscrepancyWithRunDetails by construction via selectWithRunDetails()
        .orderBy(desc(reconciliationDiscrepancies.id)) as Promise<
        DiscrepancyWithRunDetails[]
      >
    );
  }
}
