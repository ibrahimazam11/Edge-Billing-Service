import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase, TransactionClient } from "../database/types";
import { charges } from "../database/schema/charges";
import { paymentMethods } from "../database/schema/payment-methods";
import { isDuplicateKeyError } from "../common/utils/error.util";

type Charge = typeof charges.$inferSelect;
type NewCharge = typeof charges.$inferInsert;

export type ChargeWithPaymentMethod = {
  id: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
  status: string;
  stripePaymentIntentId: string | null;
  failureReason: string | null;
  attemptNumber: number;
  createdAt: Date;
  paymentMethodType: string | null;
  gatewayProvider: string | null;
};

@Injectable()
export class ChargesRepository extends BaseRepository<typeof charges> {
  protected readonly table = charges;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async findByIdempotencyKey(key: string): Promise<Charge | null> {
    const [row] = await this.db
      .select()
      .from(charges)
      .where(eq(charges.idempotencyKey, key))
      .limit(1);
    return row ?? null;
  }

  async findByStripePaymentIntentId(intentId: string): Promise<Charge | null> {
    const [row] = await this.db
      .select()
      .from(charges)
      .where(eq(charges.stripePaymentIntentId, intentId))
      .limit(1);
    return row ?? null;
  }

  async findByInvoiceId(invoiceId: string): Promise<Charge[]> {
    return this.db
      .select()
      .from(charges)
      .where(eq(charges.invoiceId, invoiceId));
  }

  /**
   * Fetches `limit + 1` rows to enable cursor-based "has more" pagination.
   * Callers should check `results.length > limit` to determine if more rows exist.
   */
  async findByCustomerWithPaymentMethod(
    customerId: string,
    filters: { dateFrom?: string; dateTo?: string; cursor?: string },
    limit: number,
  ): Promise<ChargeWithPaymentMethod[]> {
    const conditions: SQL[] = [eq(charges.customerId, customerId)];

    if (filters.dateFrom) {
      conditions.push(gte(charges.createdAt, new Date(filters.dateFrom)));
    }
    if (filters.dateTo) {
      conditions.push(lt(charges.createdAt, new Date(filters.dateTo)));
    }
    if (filters.cursor) {
      conditions.push(lt(charges.id, filters.cursor));
    }

    return this.db
      .select({
        id: charges.id,
        invoiceId: charges.invoiceId,
        amountCents: charges.amountCents,
        currency: charges.currency,
        status: charges.status,
        stripePaymentIntentId: charges.stripePaymentIntentId,
        failureReason: charges.failureReason,
        attemptNumber: charges.attemptNumber,
        createdAt: charges.createdAt,
        paymentMethodType: paymentMethods.type,
        gatewayProvider: paymentMethods.gatewayProvider,
      })
      .from(charges)
      .leftJoin(paymentMethods, eq(charges.paymentMethodId, paymentMethods.id))
      .where(and(...conditions))
      .orderBy(desc(charges.id))
      .limit(limit + 1);
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
  ): Promise<Charge[]> {
    const conditions: SQL[] = [eq(charges.customerId, customerId)];

    conditions.push(
      ...this.buildDateRangeConditions(
        charges.createdAt,
        filters.startDate,
        filters.endDate,
      ),
    );

    const cursorCondition = this.buildTimestampCursorCondition(
      charges.createdAt,
      filters.cursor,
    );
    if (cursorCondition) conditions.push(cursorCondition);

    return this.db
      .select()
      .from(charges)
      .where(and(...conditions))
      .orderBy(desc(charges.createdAt))
      .limit(limit + 1);
  }

  /** @override Use createWithIdempotency() for idempotent inserts. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override create(_data: never, _tx?: TransactionClient): Promise<never> {
    return Promise.reject(
      new Error(
        "ChargesRepository: use createWithIdempotency() for idempotent inserts.",
      ),
    );
  }

  /**
   * Idempotent create — returns `{ charge, isDuplicate }`.
   * Does NOT match base `create()` signature; this is the domain-specific create.
   */
  async createWithIdempotency(
    data: NewCharge,
  ): Promise<{ charge: Charge; isDuplicate: boolean }> {
    try {
      const [row] = await this.db.insert(charges).values(data).returning();
      return { charge: row, isDuplicate: false };
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        const existing = await this.findByIdempotencyKey(data.idempotencyKey);
        if (existing) {
          return { charge: existing, isDuplicate: true };
        }
      }
      throw error;
    }
  }

  async updateStatus(
    id: string,
    data: Partial<Charge>,
    tx?: TransactionClient,
  ): Promise<void> {
    await this.conn(tx).update(charges).set(data).where(eq(charges.id, id));
  }

  async findByIds(ids: string[]): Promise<Charge[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(charges).where(inArray(charges.id, ids));
  }

  async aggregateSuccessRateByDateRange(
    periodStart: string,
    periodEnd: string,
  ): Promise<{ totalCharges: number; succeededCharges: number }> {
    const result = await this.db.execute(sql`
      SELECT
        COUNT(*)::int AS "totalCharges",
        COUNT(CASE WHEN status = 'succeeded' THEN 1 END)::int AS "succeededCharges"
      FROM charges
      WHERE created_at >= ${periodStart} AND created_at < ${periodEnd}
    `);
    const row = result.rows[0] as
      | { totalCharges: number; succeededCharges: number }
      | undefined;
    return row ?? { totalCharges: 0, succeededCharges: 0 };
  }
}
