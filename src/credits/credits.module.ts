import { Module, forwardRef } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module";
import { CustomersModule } from "../customers/customers.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { DatabaseModule } from "../database/database.module";
import { CreditsService } from "./credits.service";
import { CreditsController } from "./credits.controller";
import { CreditNotesRepository } from "./credit-notes.repository";
import { CreditBalancesRepository } from "./credit-balances.repository";

@Module({
  imports: [
    DatabaseModule,
    LedgerModule,
    CustomersModule,
    forwardRef(() => InvoicesModule),
  ],
  controllers: [CreditsController],
  providers: [CreditsService, CreditNotesRepository, CreditBalancesRepository],
  exports: [CreditsService, CreditNotesRepository, CreditBalancesRepository],
})
export class CreditsModule {}
