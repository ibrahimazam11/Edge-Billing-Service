import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase, TransactionClient } from "../database/types";
import { subscriptions } from "../database/schema/subscriptions";
import { customers } from "../database/schema/customers";

type Subscription = typeof subscriptions.$inferSelect;

@Injectable()
export class SubscriptionsRepository extends BaseRepository<
  typeof subscriptions
> {
  protected readonly table = subscriptions;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async findByCustomer(
    customerId: string,
    filters: { status?: string; cursor?: string },
    limit: number,
  ): Promise<Subscription[]> {
    const conditions: SQL[] = [eq(subscriptions.customerId, customerId)];

    if (filters.status) {
      conditions.push(eq(subscriptions.status, filters.status));
    }

    const cursorCondition = this.buildCursorCondition(
      subscriptions.id,
      filters.cursor,
    );
    if (cursorCondition) conditions.push(cursorCondition);

    return this.db
      .select()
      .from(subscriptions)
      .where(this.buildWhereClause(conditions))
      .orderBy(subscriptions.id)
      .limit(limit + 1);
  }

  async findDueForBilling(scheduledDate: Date): Promise<Subscription[]> {
    return this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.status, "active"),
          lte(subscriptions.nextBillingDate, scheduledDate),
        ),
      );
  }

  async findByCustomerAndStatuses(
    customerId: string,
    statuses: string[],
  ): Promise<Subscription[]> {
    return this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.customerId, customerId),
          inArray(subscriptions.status, statuses),
        ),
      );
  }

  async updateByCustomerAndStatuses(
    customerId: string,
    statuses: string[],
    data: Partial<Subscription>,
  ): Promise<void> {
    await this.db
      .update(subscriptions)
      .set(data)
      .where(
        and(
          eq(subscriptions.customerId, customerId),
          inArray(subscriptions.status, statuses),
        ),
      );
  }

  async updateStateWithConcurrencyCheck(
    id: string,
    data: Partial<Subscription>,
    expectedStatus: string,
    tx?: TransactionClient,
  ): Promise<Subscription | null> {
    const [row] = await this.conn(tx)
      .update(subscriptions)
      .set(data)
      .where(
        and(eq(subscriptions.id, id), eq(subscriptions.status, expectedStatus)),
      )
      .returning();
    return row ?? null;
  }

  async findAllWithFilters(
    filters: {
      customerId?: string;
      status?: string;
      startDate?: string;
      endDate?: string;
      cursor?: string;
    },
    limit: number,
  ): Promise<Subscription[]> {
    const conditions: SQL[] = [];

    if (filters.customerId) {
      conditions.push(eq(subscriptions.customerId, filters.customerId));
    }
    if (filters.status) {
      conditions.push(eq(subscriptions.status, filters.status));
    }
    if (filters.startDate) {
      conditions.push(
        gte(subscriptions.createdAt, new Date(filters.startDate)),
      );
    }
    if (filters.endDate) {
      conditions.push(lte(subscriptions.createdAt, new Date(filters.endDate)));
    }

    const cursorCondition = this.buildCursorCondition(
      subscriptions.id,
      filters.cursor,
    );
    if (cursorCondition) conditions.push(cursorCondition);

    return this.db
      .select()
      .from(subscriptions)
      .where(this.buildWhereClause(conditions))
      .orderBy(subscriptions.id)
      .limit(limit + 1);
  }

  async getActiveMetrics(): Promise<{ activeCount: number; mrr: number }> {
    const result = await this.db.execute(
      sql`SELECT COUNT(*)::int AS "activeCount", COALESCE(SUM(amount_cents), 0)::int AS "mrr" FROM subscriptions WHERE status = 'active'`,
    );
    const row = result.rows[0] as
      | { activeCount: number; mrr: number }
      | undefined;
    return row ?? { activeCount: 0, mrr: 0 };
  }

  async findAllWithCustomer(
    filters: {
      customerId?: string;
      status?: string;
      startDate?: string;
      endDate?: string;
      cursor?: string;
    },
    limit: number,
  ): Promise<
    {
      subscription: Subscription;
      customerName: string | null;
      customerEmail: string | null;
    }[]
  > {
    const conditions: SQL[] = [];

    if (filters.customerId) {
      conditions.push(eq(subscriptions.customerId, filters.customerId));
    }
    if (filters.status) {
      conditions.push(eq(subscriptions.status, filters.status));
    }
    if (filters.startDate) {
      conditions.push(
        gte(subscriptions.createdAt, new Date(filters.startDate)),
      );
    }
    if (filters.endDate) {
      conditions.push(lte(subscriptions.createdAt, new Date(filters.endDate)));
    }
    if (filters.cursor) {
      conditions.push(gt(subscriptions.id, filters.cursor));
    }

    return this.db
      .select({
        subscription: subscriptions,
        customerName: customers.name,
        customerEmail: customers.email,
      })
      .from(subscriptions)
      .leftJoin(customers, eq(subscriptions.customerId, customers.id))
      .where(this.buildWhereClause(conditions))
      .orderBy(subscriptions.id)
      .limit(limit + 1);
  }
}
