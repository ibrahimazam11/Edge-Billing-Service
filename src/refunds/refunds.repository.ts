import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase, TransactionClient } from "../database/types";
import { refunds } from "../database/schema/refunds";
import { isDuplicateKeyError } from "../common/utils/error.util";

type Refund = typeof refunds.$inferSelect;
type NewRefund = typeof refunds.$inferInsert;

@Injectable()
export class RefundsRepository extends BaseRepository<typeof refunds> {
  protected readonly table = refunds;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async findByIdempotencyKey(key: string): Promise<Refund | null> {
    const [row] = await this.db
      .select()
      .from(refunds)
      .where(eq(refunds.idempotencyKey, key))
      .limit(1);
    return row ?? null;
  }

  async findSucceededByChargeId(chargeId: string): Promise<Refund[]> {
    return this.db
      .select()
      .from(refunds)
      .where(
        and(eq(refunds.chargeId, chargeId), eq(refunds.status, "succeeded")),
      );
  }

  /**
   * Returns full rows; callers handle field selection.
   * Fetches `limit + 1` rows to enable cursor-based "has more" pagination.
   * Callers should check `results.length > limit` to determine if more rows exist.
   */
  async findForBillingHistory(
    customerId: string,
    filters: { startDate?: string; endDate?: string; cursor?: Date },
    limit: number,
  ): Promise<Refund[]> {
    const conditions: SQL[] = [eq(refunds.customerId, customerId)];

    conditions.push(
      ...this.buildDateRangeConditions(
        refunds.createdAt,
        filters.startDate,
        filters.endDate,
      ),
    );

    const cursorCondition = this.buildTimestampCursorCondition(
      refunds.createdAt,
      filters.cursor,
    );
    if (cursorCondition) conditions.push(cursorCondition);

    return this.db
      .select()
      .from(refunds)
      .where(and(...conditions))
      .orderBy(desc(refunds.createdAt))
      .limit(limit + 1);
  }

  /** @override Use createWithIdempotency() for idempotent inserts. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override create(_data: never, _tx?: TransactionClient): Promise<never> {
    return Promise.reject(
      new Error(
        "RefundsRepository: use createWithIdempotency() for idempotent inserts.",
      ),
    );
  }

  /**
   * Idempotent create — returns `{ refund, isDuplicate }`.
   * Does NOT match base `create()` signature; this is the domain-specific create.
   */
  async createWithIdempotency(
    data: NewRefund,
  ): Promise<{ refund: Refund; isDuplicate: boolean }> {
    try {
      const [row] = await this.db.insert(refunds).values(data).returning();
      return { refund: row, isDuplicate: false };
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        const existing = await this.findByIdempotencyKey(data.idempotencyKey);
        if (existing) {
          return { refund: existing, isDuplicate: true };
        }
      }
      throw error;
    }
  }

  async updateStatus(
    id: string,
    data: Partial<Refund>,
    tx?: TransactionClient,
  ): Promise<void> {
    await this.conn(tx).update(refunds).set(data).where(eq(refunds.id, id));
  }

  async updateToSucceeded(
    id: string,
    gatewayRefundId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    await this.conn(tx)
      .update(refunds)
      .set({
        status: "succeeded",
        gatewayRefundId,
        updatedAt: new Date(),
      })
      .where(eq(refunds.id, id));
  }
}
