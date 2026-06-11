import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { SentryModule } from "@sentry/nestjs/setup";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { appConfig } from "./config/app.config";
import { databaseConfig } from "./config/database.config";
import { awsConfig } from "./config/aws.config";
import { sqsConfig } from "./config/sqs.config";
import { stripeConfig } from "./config/stripe.config";
import { sentryConfig } from "./config/sentry.config";
import { authConfig } from "./config/auth.config";
import { dunningConfig } from "./config/dunning.config";
import { adyenConfig } from "./config/adyen.config";
import { HmacAuthGuard } from "./common/guards/hmac-auth.guard";
import { RolesGuard } from "./common/guards/roles.guard";
import { IntegrationModule } from "./integration/integration.module";
import { GatewayModule } from "./gateway/gateway.module";
import { CustomersModule } from "./customers/customers.module";
import { PaymentMethodsModule } from "./payment-methods/payment-methods.module";
import { SubscriptionsModule } from "./subscriptions/subscriptions.module";
import { LedgerModule } from "./ledger/ledger.module";
import { InvoicesModule } from "./invoices/invoices.module";
import { ChargesModule } from "./charges/charges.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { DunningModule } from "./dunning/dunning.module";
import { CreditsModule } from "./credits/credits.module";
import { ReconciliationModule } from "./reconciliation/reconciliation.module";
import { ReportingModule } from "./reporting/reporting.module";
import { FeatureFlagsModule } from "./feature-flags/feature-flags.module";
import { SurchargesModule } from "./surcharges/surcharges.module";
import { MigrationModule } from "./migration/migration.module";
import { CustomerMigrationModule } from "./customer-migration/customer-migration.module";
import { monolithDatabaseConfig } from "./config/monolith-database.config";
import { monolithConfig } from "./config/monolith.config";
import { AdminModule } from "./admin/admin.module";
import { RefundsModule } from "./refunds/refunds.module";
import { MonolithApiModule } from "./integration/monolith-api/monolith-api.module";

@Module({
  imports: [
    ...(process.env.SENTRY_DSN ? [SentryModule.forRoot()] : []),
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        databaseConfig,
        awsConfig,
        sqsConfig,
        stripeConfig,
        sentryConfig,
        authConfig,
        dunningConfig,
        ...(process.env.MONOLITH_DATABASE_HOST ? [monolithDatabaseConfig] : []),
        ...(process.env.ADYEN_API_KEY ? [adyenConfig] : []),
        ...(process.env.MONOLITH_API_BASE_URL ? [monolithConfig] : []),
      ],
    }),
    DatabaseModule,
    HealthModule,
    IntegrationModule,
    GatewayModule,
    CustomersModule,
    PaymentMethodsModule,
    SubscriptionsModule,
    LedgerModule,
    InvoicesModule,
    ChargesModule,
    WebhooksModule,
    DunningModule,
    CreditsModule,
    ReconciliationModule,
    ReportingModule,
    FeatureFlagsModule,
    SurchargesModule,
    MigrationModule,
    CustomerMigrationModule,
    AdminModule,
    RefundsModule,
    MonolithApiModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: HmacAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
