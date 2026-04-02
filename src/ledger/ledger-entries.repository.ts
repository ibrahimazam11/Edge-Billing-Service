import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase, TransactionClient } from "../database/types";
import { ledgerEntries } from "../database/schema/ledger-entries";

type LedgerEntry = typeof ledgerEntries.$inferSelect;
type NewLedgerEntry = typeof ledgerEntries.$inferInsert;

@Injectable()
export class LedgerEntriesRepository extends BaseRepository<
  typeof ledgerEntries
> {
  protected readonly table = ledgerEntries;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async createInTx(data: NewLedgerEntry, tx: TransactionClient): Promise<void> {
    await this.conn(tx)
      .insert(ledgerEntries)
      .values(data as never);
  }

  async findByReferenceType(
    referenceType: string,
    dateRange: { start: Date; end: Date },
  ): Promise<Pick<LedgerEntry, "referenceId">[]> {
    return this.db
      .select({ referenceId: ledgerEntries.referenceId })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.referenceType, referenceType),
          gte(ledgerEntries.createdAt, dateRange.start),
          lt(ledgerEntries.createdAt, dateRange.end),
        ),
      );
  }

  async aggregateRevenueByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<{
    totalInvoiced: number;
    totalCollected: number;
    totalWriteOff: number;
    totalCreditsIssued: number;
  }> {
    const result = await this.db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN reference_type = 'invoice' AND debit_account_id = (SELECT id FROM ledger_accounts WHERE name = 'accounts_receivable') THEN amount_cents ELSE 0 END), 0) AS "totalInvoiced",
        COALESCE(SUM(CASE WHEN reference_type = 'payment' AND debit_account_id = (SELECT id FROM ledger_accounts WHERE name = 'cash') THEN amount_cents ELSE 0 END), 0) AS "totalCollected",
        COALESCE(SUM(CASE WHEN reference_type = 'invoice_void' THEN amount_cents ELSE 0 END), 0) AS "totalWriteOff",
        COALESCE(SUM(CASE WHEN reference_type = 'credit_note' THEN amount_cents ELSE 0 END), 0) AS "totalCreditsIssued"
      FROM ledger_entries
      WHERE created_at >= ${startDate} AND created_at < ${endDate}
    `);
    const row = result.rows[0] as {
      totalInvoiced: string;
      totalCollected: string;
      totalWriteOff: string;
      totalCreditsIssued: string;
    };
    return {
      totalInvoiced: Number(row.totalInvoiced),
      totalCollected: Number(row.totalCollected),
      totalWriteOff: Number(row.totalWriteOff),
      totalCreditsIssued: Number(row.totalCreditsIssued),
    };
  }
}
