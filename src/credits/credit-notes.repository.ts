import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase, TransactionClient } from "../database/types";
import { creditNotes } from "../database/schema/credit-notes";

type CreditNote = typeof creditNotes.$inferSelect;
type NewCreditNote = typeof creditNotes.$inferInsert;

@Injectable()
export class CreditNotesRepository extends BaseRepository<typeof creditNotes> {
  protected readonly table = creditNotes;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async createInTx(data: NewCreditNote, tx: TransactionClient): Promise<void> {
    await this.conn(tx)
      .insert(creditNotes)
      .values(data as never);
  }

  async findByCustomer(customerId: string): Promise<CreditNote[]> {
    return this.db
      .select()
      .from(creditNotes)
      .where(eq(creditNotes.customerId, customerId));
  }

  async findForBillingHistory(
    customerId: string,
    filters: { startDate?: string; endDate?: string; cursor?: Date },
    limit: number,
  ): Promise<CreditNote[]> {
    const conditions: SQL[] = [eq(creditNotes.customerId, customerId)];

    conditions.push(
      ...this.buildDateRangeConditions(
        creditNotes.createdAt,
        filters.startDate,
        filters.endDate,
      ),
    );

    const cursorCondition = this.buildTimestampCursorCondition(
      creditNotes.createdAt,
      filters.cursor,
    );
    if (cursorCondition) conditions.push(cursorCondition);

    return this.db
      .select()
      .from(creditNotes)
      .where(and(...conditions))
      .orderBy(desc(creditNotes.createdAt))
      .limit(limit + 1) as Promise<CreditNote[]>;
  }
}
