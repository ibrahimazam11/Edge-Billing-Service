import { Inject, Injectable } from "@nestjs/common";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { ledgerAccounts } from "../database/schema/ledger-accounts";

type LedgerAccount = typeof ledgerAccounts.$inferSelect;

@Injectable()
export class LedgerAccountsRepository extends BaseRepository<
  typeof ledgerAccounts
> {
  protected readonly table = ledgerAccounts;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async findAll(): Promise<LedgerAccount[]> {
    return this.db.select().from(ledgerAccounts);
  }
}
