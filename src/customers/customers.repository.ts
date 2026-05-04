import { Inject, Injectable } from "@nestjs/common";
import { eq, ilike, isNotNull, sql, type SQL } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { customers } from "../database/schema/customers";

type Customer = typeof customers.$inferSelect;

@Injectable()
export class CustomersRepository extends BaseRepository<typeof customers> {
  protected readonly table = customers;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  private escapeIlike(value: string): string {
    return value.replace(/[%_\\]/g, "\\$&");
  }

  async findByMonolithId(monolithCustomerId: string): Promise<Customer | null> {
    const [row] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.monolithCustomerId, monolithCustomerId))
      .limit(1);
    return row ?? null;
  }

  async findByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<Customer | null> {
    const [row] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.stripeCustomerId, stripeCustomerId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Fetches `limit + 1` rows to enable cursor-based "has more" pagination.
   * Callers should check `results.length > limit` to determine if more rows exist.
   */
  async findAll(
    filters: { status?: string; cursor?: string },
    limit: number,
  ): Promise<Customer[]> {
    const conditions: SQL[] = [];

    if (filters.status) {
      conditions.push(eq(customers.status, filters.status));
    }

    const cursorCondition = this.buildCursorCondition(
      customers.id,
      filters.cursor,
    );
    if (cursorCondition) conditions.push(cursorCondition);

    return this.db
      .select()
      .from(customers)
      .where(this.buildWhereClause(conditions))
      .orderBy(customers.id)
      .limit(limit + 1);
  }

  /**
   * Admin-only search. Returns full Customer rows; the Admin DTO layer handles field selection.
   * Fetches `limit + 1` rows to enable cursor-based "has more" pagination.
   * Callers should check `results.length > limit` to determine if more rows exist.
   */
  async search(
    filters: {
      name?: string;
      email?: string;
      externalId?: string;
      status?: string;
      cursor?: string;
    },
    limit: number,
  ): Promise<Customer[]> {
    const conditions: SQL[] = [];

    if (filters.name) {
      conditions.push(
        ilike(customers.name, `%${this.escapeIlike(filters.name)}%`),
      );
    }
    if (filters.email) {
      conditions.push(
        ilike(customers.email, `%${this.escapeIlike(filters.email)}%`),
      );
    }
    if (filters.externalId) {
      conditions.push(eq(customers.monolithCustomerId, filters.externalId));
    }
    if (filters.status) {
      conditions.push(eq(customers.status, filters.status));
    }

    const cursorCondition = this.buildCursorCondition(
      customers.id,
      filters.cursor,
    );
    if (cursorCondition) conditions.push(cursorCondition);

    return this.db
      .select()
      .from(customers)
      .where(this.buildWhereClause(conditions))
      .orderBy(customers.id)
      .limit(limit + 1);
  }

  async findAllForMigration(): Promise<
    { id: string; monolithCustomerId: string }[]
  > {
    return this.db
      .select({
        id: customers.id,
        monolithCustomerId: customers.monolithCustomerId,
      })
      .from(customers)
      .where(isNotNull(customers.monolithCustomerId)) as Promise<
      { id: string; monolithCustomerId: string }[]
    >;
  }

  async countMonolithCustomers(): Promise<number> {
    const result = await this.db.execute(
      sql`SELECT COUNT(*)::int AS "count" FROM customers WHERE monolith_customer_id IS NOT NULL`,
    );
    const row = result.rows[0] as { count: number } | undefined;
    return row?.count ?? 0;
  }
}
