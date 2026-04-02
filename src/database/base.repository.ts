import {
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
  type Table,
  and,
  eq,
  gt,
  gte,
  lt,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { DbOrTx, DrizzleDatabase, TransactionClient } from "./types";

/**
 * Abstract base repository providing shared CRUD operations and pagination helpers.
 *
 * Subclasses must:
 * 1. Set `protected readonly table` to the Drizzle table reference
 * 2. Call `super(db)` in their constructor with the injected DrizzleDatabase
 *
 * Type casts (`as unknown as ...` / `as never`) are required because Drizzle's
 * generic Table type doesn't expose column names or satisfy the conditional
 * type constraints used by `.from()` / `.insert()` / `.update()` / `.delete()`.
 * Concrete subclasses pass real pgTable references, so these casts are safe at runtime.
 */
export abstract class BaseRepository<TTable extends Table> {
  protected abstract readonly table: TTable;

  constructor(protected readonly db: DrizzleDatabase) {}

  protected conn(tx?: TransactionClient): DbOrTx {
    return tx ?? this.db;
  }

  async findById(
    id: string,
    tx?: TransactionClient,
  ): Promise<InferSelectModel<TTable> | null> {
    const idColumn = (this.table as unknown as Record<string, PgColumn>).id;
    const [row] = (await this.conn(tx)
      .select()
      .from(this.table as never)
      .where(eq(idColumn, id))
      .limit(1)) as InferSelectModel<TTable>[];
    return row ?? null;
  }

  async create(
    data: InferInsertModel<TTable>,
    tx?: TransactionClient,
  ): Promise<InferSelectModel<TTable>> {
    const [row] = (await this.conn(tx)
      .insert(this.table as never)
      .values(data as never)
      .returning()) as InferSelectModel<TTable>[];
    if (!row) throw new Error("Expected row to be returned from INSERT");
    return row;
  }

  async update(
    id: string,
    data: Partial<InferInsertModel<TTable>>,
    tx?: TransactionClient,
  ): Promise<InferSelectModel<TTable>> {
    const idColumn = (this.table as unknown as Record<string, PgColumn>).id;
    const [row] = (await this.conn(tx)
      .update(this.table as never)
      .set(data as never)
      .where(eq(idColumn, id))
      .returning()) as InferSelectModel<TTable>[];
    if (!row) throw new Error("Expected row to be returned from UPDATE");
    return row;
  }

  async deleteById(id: string, tx?: TransactionClient): Promise<void> {
    const idColumn = (this.table as unknown as Record<string, PgColumn>).id;
    await this.conn(tx)
      .delete(this.table as never)
      .where(eq(idColumn, id));
  }

  protected buildWhereClause(conditions: SQL[]): SQL | undefined {
    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  protected buildDateRangeConditions(
    column: PgColumn,
    startDate?: string,
    endDate?: string,
  ): SQL[] {
    const conditions: SQL[] = [];
    if (startDate) {
      const d = new Date(startDate);
      if (isNaN(d.getTime()))
        throw new Error(`Invalid startDate: ${startDate}`);
      conditions.push(gte(column, d));
    }
    if (endDate) {
      const d = new Date(endDate);
      if (isNaN(d.getTime())) throw new Error(`Invalid endDate: ${endDate}`);
      conditions.push(lt(column, d));
    }
    return conditions;
  }

  protected buildCursorCondition(
    column: PgColumn,
    cursor: string | undefined,
  ): SQL | undefined {
    return cursor ? gt(column, cursor) : undefined;
  }

  protected buildTimestampCursorCondition(
    column: PgColumn,
    cursor: Date | undefined,
  ): SQL | undefined {
    return cursor ? lt(column, cursor) : undefined;
  }
}
