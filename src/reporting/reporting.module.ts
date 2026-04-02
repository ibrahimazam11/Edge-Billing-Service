import { Module } from "@nestjs/common";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { LedgerModule } from "../ledger/ledger.module";
import { ChargesModule } from "../charges/charges.module";
import { DunningModule } from "../dunning/dunning.module";
import { ReconciliationModule } from "../reconciliation/reconciliation.module";
import { ReportingService } from "./reporting.service";
import { ReportingController } from "./reporting.controller";

@Module({
  imports: [
    SubscriptionsModule,
    LedgerModule,
    ChargesModule,
    DunningModule,
    ReconciliationModule,
  ],
  controllers: [ReportingController],
  providers: [ReportingService],
})
export class ReportingModule {}
