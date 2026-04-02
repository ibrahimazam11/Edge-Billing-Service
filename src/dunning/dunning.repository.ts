import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lt, lte, ne, sql, type SQL } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase, TransactionClient } from "../database/types";
import { dunningAttempts } from "../database/schema/dunning-attempts";
import { invoices } from "../database/schema/invoices";
import { paymentMethods } from "../database/schema/payment-methods";

type DunningAttempt = typeof dunningAttempts.$inferSelect;
type NewDunningAttempt = typeof dunningAttempts.$inferInsert;

export type DunningAttemptWithDetails = {
  id: string;
  invoiceId: string;
  chargeId: string | null;
  paymentMethodId: string | null;
  attemptNumber: number;
  scheduledDate: Date;
  executedAt: Date | null;
  status: string;
  failureReason: string | null;
  createdAt: Date;
  paymentMethodType: string | null;
  gatewayProvider: string | null;
};

@Injectable()
export class DunningAttemptsRepository extends BaseRepository<
  typeof dunningAttempts
> {
  protected readonly table = dunningAttempts;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async findByInvoiceId(invoiceId: string): Promise<DunningAttempt[]> {
    return this.db
      .select()
      .from(dunningAttempts)
      .where(eq(dunningAttempts.invoiceId, invoiceId))
      .orderBy(dunningAttempts.attemptNumber);
  }

  async findScheduled(): Promise<DunningAttempt[]> {
    const now = new Date();
    return this.db
      .select()
      .from(dunningAttempts)
      .where(
        and(
          eq(dunningAttempts.status, "scheduled"),
          lte(dunningAttempts.scheduledDate, now),
        ),
      )
      .orderBy(dunningAttempts.scheduledDate);
  }

  async findExistingNonSkipped(invoiceId: string): Promise<DunningAttempt[]> {
    return this.db
      .select()
      .from(dunningAttempts)
      .where(
        and(
          eq(dunningAttempts.invoiceId, invoiceId),
          ne(dunningAttempts.status, "skipped"),
        ),
      );
  }

  async insert(data: NewDunningAttempt, tx?: TransactionClient): Promise<void> {
    await this.conn(tx).insert(dunningAttempts).values(data);
  }

  async updateStatus(
    id: string,
    data: Partial<DunningAttempt>,
    tx?: TransactionClient,
  ): Promise<void> {
    await this.conn(tx)
      .update(dunningAttempts)
      .set(data)
      .where(eq(dunningAttempts.id, id));
  }

  async markRemainingAsSkipped(
    invoiceId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    await this.conn(tx)
      .update(dunningAttempts)
      .set({ status: "skipped" })
      .where(
        and(
          eq(dunningAttempts.invoiceId, invoiceId),
          eq(dunningAttempts.status, "scheduled"),
        ),
      );
  }

  /**
   * Fetches `limit + 1` rows to enable cursor-based "has more" pagination.
   * Callers should check `results.length > limit` to determine if more rows exist.
   */
  async findWithInvoiceAndPaymentMethod(
    customerId: string,
    filters: { dateFrom?: string; dateTo?: string; cursor?: string },
    limit: number,
  ): Promise<DunningAttemptWithDetails[]> {
    const conditions: SQL[] = [eq(invoices.customerId, customerId)];

    if (filters.dateFrom) {
      conditions.push(
        gte(dunningAttempts.createdAt, new Date(filters.dateFrom)),
      );
    }
    if (filters.dateTo) {
      conditions.push(lt(dunningAttempts.createdAt, new Date(filters.dateTo)));
    }
    if (filters.cursor) {
      conditions.push(lt(dunningAttempts.id, filters.cursor));
    }

    return this.db
      .select({
        id: dunningAttempts.id,
        invoiceId: dunningAttempts.invoiceId,
        chargeId: dunningAttempts.chargeId,
        paymentMethodId: dunningAttempts.paymentMethodId,
        attemptNumber: dunningAttempts.attemptNumber,
        scheduledDate: dunningAttempts.scheduledDate,
        executedAt: dunningAttempts.executedAt,
        status: dunningAttempts.status,
        failureReason: dunningAttempts.failureReason,
        createdAt: dunningAttempts.createdAt,
        paymentMethodType: paymentMethods.type,
        gatewayProvider: paymentMethods.gatewayProvider,
      })
      .from(dunningAttempts)
      .innerJoin(invoices, eq(dunningAttempts.invoiceId, invoices.id))
      .leftJoin(
        paymentMethods,
        eq(dunningAttempts.paymentMethodId, paymentMethods.id),
      )
      .where(and(...conditions))
      .orderBy(desc(dunningAttempts.id))
      .limit(limit + 1);
  }

  async aggregateDunningByDateRange(
    periodStart: string,
    periodEnd: string,
  ): Promise<{
    totalInvoicesInDunning: number;
    recoveredCount: number;
    recoveredAmountCents: number;
    avgRecoveryAttempts: number;
  }> {
    const result = await this.db.execute(sql`
      SELECT
        COUNT(DISTINCT da.invoice_id)::int AS "totalInvoicesInDunning",
        COUNT(DISTINCT CASE WHEN da.status = 'succeeded' THEN da.invoice_id END)::int AS "recoveredCount",
        COALESCE((
          SELECT SUM(i2.total_amount_cents)
          FROM invoices i2
          WHERE i2.id IN (
            SELECT DISTINCT da2.invoice_id FROM dunning_attempts da2
            WHERE da2.status = 'succeeded'
              AND da2.created_at >= ${periodStart} AND da2.created_at < ${periodEnd}
          )
        ), 0)::int AS "recoveredAmountCents",
        COALESCE(AVG(CASE WHEN da.status = 'succeeded' THEN da.attempt_number END), 0) AS "avgRecoveryAttempts"
      FROM dunning_attempts da
      JOIN invoices i ON i.id = da.invoice_id
      WHERE da.created_at >= ${periodStart} AND da.created_at < ${periodEnd}
    `);
    const row = result.rows[0] as
      | {
          totalInvoicesInDunning: number;
          recoveredCount: number;
          recoveredAmountCents: number;
          avgRecoveryAttempts: string;
        }
      | undefined;
    return {
      totalInvoicesInDunning: row?.totalInvoicesInDunning ?? 0,
      recoveredCount: row?.recoveredCount ?? 0,
      recoveredAmountCents: row?.recoveredAmountCents ?? 0,
      avgRecoveryAttempts: Number(row?.avgRecoveryAttempts ?? 0),
    };
  }

  async aggregateEscalatedByDateRange(
    periodStart: string,
    periodEnd: string,
  ): Promise<{ escalatedCount: number; escalatedAmountCents: number }> {
    const result = await this.db.execute(sql`
      SELECT
        COUNT(DISTINCT da.invoice_id)::int AS "escalatedCount",
        COALESCE((
          SELECT SUM(i2.total_amount_cents)
          FROM invoices i2
          WHERE i2.id IN (
            SELECT DISTINCT da2.invoice_id FROM dunning_attempts da2
            WHERE da2.created_at >= ${periodStart} AND da2.created_at < ${periodEnd}
              AND da2.invoice_id NOT IN (
                SELECT DISTINCT da3.invoice_id FROM dunning_attempts da3
                WHERE da3.created_at >= ${periodStart} AND da3.created_at < ${periodEnd}
                  AND da3.status IN ('succeeded', 'scheduled')
              )
          )
        ), 0)::int AS "escalatedAmountCents"
      FROM dunning_attempts da
      WHERE da.created_at >= ${periodStart} AND da.created_at < ${periodEnd}
        AND da.invoice_id NOT IN (
          SELECT DISTINCT invoice_id FROM dunning_attempts
          WHERE created_at >= ${periodStart} AND created_at < ${periodEnd}
            AND status IN ('succeeded', 'scheduled')
        )
    `);
    const row = result.rows[0] as
      | { escalatedCount: number; escalatedAmountCents: number }
      | undefined;
    return row ?? { escalatedCount: 0, escalatedAmountCents: 0 };
  }

  async aggregateRecoveryByAttempt(
    periodStart: string,
    periodEnd: string,
  ): Promise<{ attemptNumber: number; count: number }[]> {
    const result = await this.db.execute(sql`
      SELECT attempt_number::int AS "attemptNumber", COUNT(*)::int AS "count"
      FROM dunning_attempts
      WHERE status = 'succeeded'
        AND created_at >= ${periodStart} AND created_at < ${periodEnd}
      GROUP BY attempt_number
      ORDER BY attempt_number
    `);
    return result.rows as { attemptNumber: number; count: number }[];
  }

  async aggregateDunningStats(
    periodStart: string,
    periodEnd: string,
  ): Promise<{ totalDunning: number; recovered: number }> {
    const result = await this.db.execute(sql`
      SELECT
        COUNT(DISTINCT invoice_id)::int AS "totalDunning",
        COUNT(DISTINCT CASE WHEN status = 'succeeded' THEN invoice_id END)::int AS "recovered"
      FROM dunning_attempts
      WHERE created_at >= ${periodStart} AND created_at < ${periodEnd}
    `);
    const row = result.rows[0] as
      | { totalDunning: number; recovered: number }
      | undefined;
    return row ?? { totalDunning: 0, recovered: 0 };
  }
}
