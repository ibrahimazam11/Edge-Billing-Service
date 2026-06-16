import { Module } from "@nestjs/common";
import { CustomersModule } from "../customers/customers.module";
import { PaymentMethodsModule } from "../payment-methods/payment-methods.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { SurchargesModule } from "../surcharges/surcharges.module";
import { CreditsModule } from "../credits/credits.module";
import { LedgerModule } from "../ledger/ledger.module";
import { GatewayModule } from "../gateway/gateway.module";
import { DatabaseModule } from "../database/database.module";

import { CustomerMigrationController } from "./customer-migration.controller";
import { CustomerMigrationOrchestratorService } from "./customer-migration.orchestrator.service";
import { CustomerMigrationCleanupService } from "./customer-migration-cleanup.service";
import { CustomerMigrationLogsRepository } from "./customer-migration-logs.repository";
import { PaymentSettingsWriter } from "./writers/payment-settings.writer";
import { CreditBalanceWriter } from "./writers/credit-balance.writer";
import { SurchargeWriter } from "./writers/surcharge.writer";
import { PayrollsWriter } from "./writers/payrolls.writer";
import { ChargesWriter } from "./writers/charges.writer";
import { SubscriptionWriter } from "./writers/subscription.writer";

@Module({
  imports: [
    DatabaseModule,
    CustomersModule,
    PaymentMethodsModule,
    InvoicesModule,
    SubscriptionsModule,
    SurchargesModule,
    CreditsModule,
    LedgerModule,
    GatewayModule,
  ],
  controllers: [CustomerMigrationController],
  providers: [
    CustomerMigrationOrchestratorService,
    CustomerMigrationCleanupService,
    CustomerMigrationLogsRepository,
    PaymentSettingsWriter,
    CreditBalanceWriter,
    SurchargeWriter,
    PayrollsWriter,
    ChargesWriter,
    SubscriptionWriter,
  ],
  exports: [
    CustomerMigrationOrchestratorService,
    CustomerMigrationCleanupService,
  ],
})
export class CustomerMigrationModule {}
