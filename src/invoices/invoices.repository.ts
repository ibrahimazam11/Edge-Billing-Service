import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase, TransactionClient } from "../database/types";
import { invoices } from "../database/schema/invoices";
import { invoiceLineItems } from "../database/schema/invoice-line-items";

type Invoice = typeof invoices.$inferSelect;
type NewInvoice = typeof invoices.$inferInsert;
type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
type NewInvoiceLineItem = typeof invoiceLineItems.$inferInsert;

@Injectable()
export class InvoicesRepository extends BaseRepository<typeof invoices> {
  protected readonly table = invoices;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async findByIdWithLineItems(
    id: string,
    tx?: TransactionClient,
  ): Promise<{ invoice: Invoice; lineItems: InvoiceLineItem[] } | null> {
    const invoice = await this.findById(id, tx);
    if (!invoice) return null;

    const items = await this.conn(tx)
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, id));

    return { invoice, lineItems: items };
  }

  /**
   * Fetches `limit + 1` rows to enable cursor-based "has more" pagination.
   * Callers should check `results.length > limit` to determine if more rows exist.
   */
  async findAll(
    filters: {
      customerId?: string;
      status?: string;
      type?: string;
      startDate?: string;
      endDate?: string;
      cursor?: string;
    },
    limit: number,
  ): Promise<Invoice[]> {
    const conditions: SQL[] = [];

    if (filters.customerId) {
      conditions.push(eq(invoices.customerId, filters.customerId));
    }
    if (filters.status) {
      conditions.push(eq(invoices.status, filters.status));
    }
    if (filters.type) {
      conditions.push(eq(invoices.type, filters.type));
    }
    if (filters.startDate) {
      conditions.push(gte(invoices.createdAt, new Date(filters.startDate)));
    }
    if (filters.endDate) {
      conditions.push(lte(invoices.createdAt, new Date(filters.endDate)));
    }

    const cursorCondition = this.buildCursorCondition(
      invoices.id,
      filters.cursor,
    );
    if (cursorCondition) conditions.push(cursorCondition);

    // Order by billing month, newest first — what the customer-facing payment
    // history wants at the top of the list. `id` is a time-of-INSERT-ordered
    // UUIDv7, so ordering by it surfaces the oldest-migrated invoices first
    // (the inverse of what the UI expects). `created_at DESC` is a stable
    // tiebreaker for rows sharing the same billing month. `billing_period_start`
    // is NOT NULL (see schema), so no NULLS-LAST handling is required.
    return this.db
      .select()
      .from(invoices)
      .where(this.buildWhereClause(conditions))
      .orderBy(desc(invoices.billingPeriodStart), desc(invoices.createdAt))
      .limit(limit + 1);
  }

  async findPendingOnboarding(scheduledDate: Date): Promise<Invoice[]> {
    return this.db
      .select()
      .from(invoices)
      .where(
        and(
          inArray(invoices.type, ["onboarding", "one_time"]),
          eq(invoices.status, "draft"),
          lte(invoices.dueDate, scheduledDate),
        ),
      );
  }

  async findDuplicateForSubscription(
    subscriptionId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<Invoice[]> {
    return this.db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.subscriptionId, subscriptionId),
          eq(invoices.billingPeriodStart, periodStart),
          eq(invoices.billingPeriodEnd, periodEnd),
        ),
      );
  }

  async getLineItemsByInvoiceId(
    invoiceId: string,
    tx?: TransactionClient,
  ): Promise<InvoiceLineItem[]> {
    return this.conn(tx)
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId));
  }

  async getLineItemsByInvoiceIds(ids: string[]): Promise<InvoiceLineItem[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(invoiceLineItems)
      .where(inArray(invoiceLineItems.invoiceId, ids));
  }

  async createLineItem(
    data: NewInvoiceLineItem,
    tx?: TransactionClient,
  ): Promise<void> {
    await this.conn(tx).insert(invoiceLineItems).values(data);
  }

  async createLineItems(
    data: NewInvoiceLineItem[],
    tx?: TransactionClient,
  ): Promise<void> {
    if (data.length === 0) return;
    await this.conn(tx).insert(invoiceLineItems).values(data);
  }

  async deleteLineItemsByInvoiceId(
    invoiceId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    await this.conn(tx)
      .delete(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId));
  }

  async deleteLineItemsByInvoiceIdAndType(
    invoiceId: string,
    type: string,
    tx?: TransactionClient,
  ): Promise<void> {
    await this.conn(tx)
      .delete(invoiceLineItems)
      .where(
        and(
          eq(invoiceLineItems.invoiceId, invoiceId),
          eq(invoiceLineItems.type, type),
        ),
      );
  }

  /**
   * Counts open recurring drafts for a customer, capped at 2. Expected to be
   * 0 or 1; >=2 signals an upstream invariant break the caller should
   * ERROR-log. Capped scan keeps this diagnostic cheap even if a corrupted
   * customer accumulates many stale drafts.
   */
  async countOpenRecurringDrafts(customerId: string): Promise<number> {
    const rows = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.customerId, customerId),
          eq(invoices.status, "draft"),
          eq(invoices.type, "recurring"),
        ),
      )
      .limit(2);
    return rows.length;
  }

  /**
   * Returns the customer's open *recurring draft* — the only invoice payroll
   * resolution is allowed to mutate. Filters strictly to `status='draft' AND
   * type='recurring'`, never returns onboarding, one-time, finalized, paid, or
   * voided invoices. Ordered `createdAt DESC` so that, in the anomalous case of
   * multiple drafts, the most recent wins; the caller is expected to log the
   * anomaly when that happens.
   */
  async findOpenRecurringDraft(customerId: string): Promise<Invoice | null> {
    const [row] = await this.db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.customerId, customerId),
          eq(invoices.status, "draft"),
          eq(invoices.type, "recurring"),
        ),
      )
      .orderBy(desc(invoices.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Backfills `subscription_id` on a customer's open recurring draft(s),
   * linking them to a freshly-created BS subscription. Called by
   * customer-migration's SubscriptionWriter, which creates the subscription
   * LAST — after payroll invoices are written — so the going-forward draft
   * (mapped by PayrollsWriter from the latest un-paid placeholder) is inserted
   * with `subscription_id = NULL` and nothing links it to the new subscription.
   *
   * Scope is deliberately narrow: only `status='draft' AND type='recurring' AND
   * subscription_id IS NULL`. Historical paid/finalized/void rows keep
   * `subscription_id = NULL` — they were Stripe-managed cycles that pre-date BS
   * owning the subscription; linking them would falsely imply BS billed them.
   *
   * Returns the number of rows linked (expected 0 or 1 per migrated customer).
   */
  async linkOpenRecurringDraftToSubscription(
    customerId: string,
    subscriptionId: string,
    tx?: TransactionClient,
  ): Promise<number> {
    const rows = await this.conn(tx)
      .update(invoices)
      .set({ subscriptionId, updatedAt: new Date() })
      .where(
        and(
          eq(invoices.customerId, customerId),
          eq(invoices.type, "recurring"),
          eq(invoices.status, "draft"),
          isNull(invoices.subscriptionId),
        ),
      )
      .returning({ id: invoices.id });
    return rows.length;
  }

  async findDraftByCustomerId(customerId: string): Promise<Invoice | null> {
    const [row] = await this.db
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.customerId, customerId), eq(invoices.status, "draft")),
      )
      .orderBy(invoices.createdAt)
      .limit(1);
    return row ?? null;
  }

  async updateWithConcurrencyCheck(
    id: string,
    data: Partial<NewInvoice>,
    expectedStatus: string,
    tx?: TransactionClient,
  ): Promise<Invoice | null> {
    const [row] = await this.conn(tx)
      .update(invoices)
      .set(data)
      .where(and(eq(invoices.id, id), eq(invoices.status, expectedStatus)))
      .returning();
    return row ?? null;
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
  ): Promise<Invoice[]> {
    const conditions: SQL[] = [eq(invoices.customerId, customerId)];

    conditions.push(
      ...this.buildDateRangeConditions(
        invoices.createdAt,
        filters.startDate,
        filters.endDate,
      ),
    );

    const cursorCondition = this.buildTimestampCursorCondition(
      invoices.createdAt,
      filters.cursor,
    );
    if (cursorCondition) conditions.push(cursorCondition);

    return this.db
      .select()
      .from(invoices)
      .where(and(...conditions))
      .orderBy(desc(invoices.createdAt))
      .limit(limit + 1);
  }

  /**
   * Admin-only search. Returns full Invoice rows; the Admin DTO layer handles field selection.
   * Fetches `limit + 1` rows to enable cursor-based "has more" pagination.
   * Callers should check `results.length > limit` to determine if more rows exist.
   */
  async searchForAdmin(
    filters: {
      customerId?: string;
      status?: string;
      dateFrom?: string;
      dateTo?: string;
      amountMin?: number;
      amountMax?: number;
      cursor?: string;
    },
    limit: number,
  ): Promise<Invoice[]> {
    const conditions: SQL[] = [];

    if (filters.customerId) {
      conditions.push(eq(invoices.customerId, filters.customerId));
    }
    if (filters.status) {
      conditions.push(eq(invoices.status, filters.status));
    }

    conditions.push(
      ...this.buildDateRangeConditions(
        invoices.createdAt,
        filters.dateFrom,
        filters.dateTo,
      ),
    );

    if (filters.amountMin !== undefined) {
      conditions.push(gte(invoices.totalAmountCents, filters.amountMin));
    }
    if (filters.amountMax !== undefined) {
      conditions.push(lte(invoices.totalAmountCents, filters.amountMax));
    }
    if (filters.cursor) {
      conditions.push(lt(invoices.id, filters.cursor));
    }

    return this.db
      .select()
      .from(invoices)
      .where(this.buildWhereClause(conditions))
      .orderBy(desc(invoices.id))
      .limit(limit + 1);
  }

  /**
   * Looks up an invoice by a specific metadata key/value pair.
   * Used for migration idempotency checks (e.g. monolith_payroll_id, monolith_charge_id).
   */
  async findByMonolithMetadata(
    key: string,
    value: string,
  ): Promise<Invoice | null> {
    const [row] = await this.db
      .select()
      .from(invoices)
      .where(sql`${invoices.metadata}->>${key} = ${value}`)
      .limit(1);
    return row ?? null;
  }

  async getBillingStatsForMigration(
    customerId: string,
    metadataKey: string,
  ): Promise<{ count: number; paidCount: number; totalCents: number }> {
    const result = await this.db.execute(
      sql`SELECT
        COUNT(*)::int as "count",
        COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END), 0)::int as "paidCount",
        COALESCE(SUM(total_amount_cents), 0)::int as "totalCents"
      FROM invoices
      WHERE customer_id = ${customerId} AND metadata->>${metadataKey} IS NOT NULL`,
    );
    const row = result.rows[0] as
      | { count: number; paidCount: number; totalCents: number }
      | undefined;
    return row ?? { count: 0, paidCount: 0, totalCents: 0 };
  }
}
