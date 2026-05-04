import { Module, forwardRef } from "@nestjs/common";
import { CustomersModule } from "../customers/customers.module";
import { GatewayModule } from "../gateway/gateway.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { LedgerModule } from "../ledger/ledger.module";
import { PaymentMethodsModule } from "../payment-methods/payment-methods.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { SurchargesModule } from "../surcharges/surcharges.module";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { ReconciliationModule } from "../reconciliation/reconciliation.module";
import { PaymentSettingsMigrationService } from "./payment-settings-migration.service";
import { ChargesMigrationService } from "./charges-migration.service";
import { PayrollBillingMigrationService } from "./payroll-billing-migration.service";
import { SurchargeConfigMigrationService } from "./surcharge-config-migration.service";
import { MigrationValidationService } from "./migration-validation.service";
import { MigrationLogsRepository } from "./migration-logs.repository";
import { MigrationController } from "./migration.controller";
import { monolithDatabaseProvider } from "./monolith-database.provider";

@Module({
  imports: [
    CustomersModule,
    GatewayModule,
    InvoicesModule,
    LedgerModule,
    forwardRef(() => PaymentMethodsModule),
    SubscriptionsModule,
    SurchargesModule,
    FeatureFlagsModule,
    ReconciliationModule,
  ],
  controllers: [MigrationController],
  providers: [
    monolithDatabaseProvider,
    MigrationLogsRepository,
    PaymentSettingsMigrationService,
    ChargesMigrationService,
    PayrollBillingMigrationService,
    SurchargeConfigMigrationService,
    MigrationValidationService,
  ],
  exports: [
    PaymentSettingsMigrationService,
    ChargesMigrationService,
    PayrollBillingMigrationService,
    SurchargeConfigMigrationService,
    MigrationValidationService,
  ],
})
export class MigrationModule {}
