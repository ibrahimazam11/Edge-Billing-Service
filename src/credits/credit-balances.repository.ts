import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase, TransactionClient } from "../database/types";
import { creditBalances } from "../database/schema/credit-balances";

type CreditBalance = typeof creditBalances.$inferSelect;
type NewCreditBalance = typeof creditBalances.$inferInsert;

@Injectable()
export class CreditBalancesRepository extends BaseRepository<
  typeof creditBalances
> {
  protected readonly table = creditBalances;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async findByCustomer(customerId: string): Promise<CreditBalance | null> {
    const [row] = await this.db
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.customerId, customerId))
      .limit(1);
    return row ?? null;
  }

  async findByCustomerInTx(
    customerId: string,
    tx: TransactionClient,
  ): Promise<CreditBalance | null> {
    const [row] = await this.conn(tx)
      .select()
      .from(creditBalances as never)
      .where(eq(creditBalances.customerId, customerId))
      .limit(1);
    return (row as CreditBalance) ?? null;
  }

  async upsertInTx(
    data: NewCreditBalance,
    incrementAmountCents: number,
    tx: TransactionClient,
  ): Promise<void> {
    await this.conn(tx)
      .insert(creditBalances as never)
      .values(data as never)
      .onConflictDoUpdate({
        target: creditBalances.customerId,
        set: {
          balanceCents: sql`${creditBalances.balanceCents} + ${incrementAmountCents}`,
          updatedAt: data.updatedAt ?? new Date(),
        },
      } as never);
  }

  async deductInTx(
    customerId: string,
    deductAmountCents: number,
    tx: TransactionClient,
  ): Promise<void> {
    await this.conn(tx)
      .update(creditBalances as never)
      .set({
        balanceCents: sql`${creditBalances.balanceCents} - ${deductAmountCents}`,
        updatedAt: new Date(),
      } as never)
      .where(eq(creditBalances.customerId, customerId));
  }
}
