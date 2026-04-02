import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { LedgerService } from "./ledger.service";
import { LedgerAccountsRepository } from "./ledger-accounts.repository";
import { LedgerEntriesRepository } from "./ledger-entries.repository";

@Module({
  imports: [DatabaseModule],
  providers: [LedgerService, LedgerAccountsRepository, LedgerEntriesRepository],
  exports: [LedgerService, LedgerAccountsRepository, LedgerEntriesRepository],
})
export class LedgerModule {}
