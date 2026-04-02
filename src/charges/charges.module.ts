import { Module, forwardRef } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { GatewayModule } from "../gateway/gateway.module";
import { LedgerModule } from "../ledger/ledger.module";
import { PaymentMethodsModule } from "../payment-methods/payment-methods.module";
import { CustomersModule } from "../customers/customers.module";
import { SqsIntegrationModule } from "../integration/sqs/sqs.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { DunningModule } from "../dunning/dunning.module";
import { DualWriteModule } from "../migration/dual-write.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { ChargesRepository } from "./charges.repository";
import { ChargesService, SUBSCRIPTIONS_SERVICE } from "./charges.service";
import { ChargesController } from "./charges.controller";
import { OnboardingChargesController } from "./onboarding-charges.controller";

@Module({
  imports: [
    DatabaseModule,
    GatewayModule,
    LedgerModule,
    PaymentMethodsModule,
    CustomersModule,
    DualWriteModule,
    forwardRef(() => SqsIntegrationModule),
    forwardRef(() => SubscriptionsModule),
    forwardRef(() => DunningModule),
    forwardRef(() => InvoicesModule),
  ],
  controllers: [ChargesController, OnboardingChargesController],
  providers: [
    ChargesRepository,
    ChargesService,
    {
      provide: SUBSCRIPTIONS_SERVICE,
      useExisting: SubscriptionsService,
    },
  ],
  exports: [ChargesRepository, ChargesService],
})
export class ChargesModule {}
