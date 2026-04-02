import { Module, forwardRef } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { GatewayModule } from "../gateway/gateway.module";
import { ChargesModule } from "../charges/charges.module";
import { LedgerModule } from "../ledger/ledger.module";
import { ReconciliationService } from "./reconciliation.service";
import { ReconciliationDiscrepanciesRepository } from "./reconciliation-discrepancies.repository";
import { ReconciliationRunsRepository } from "./reconciliation-runs.repository";

@Module({
  imports: [
    DatabaseModule,
    GatewayModule,
    forwardRef(() => ChargesModule),
    LedgerModule,
  ],
  providers: [
    ReconciliationService,
    ReconciliationDiscrepanciesRepository,
    ReconciliationRunsRepository,
  ],
  exports: [
    ReconciliationService,
    ReconciliationDiscrepanciesRepository,
    ReconciliationRunsRepository,
  ],
})
export class ReconciliationModule {}
