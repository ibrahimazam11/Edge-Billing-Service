import { Module, forwardRef } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { LedgerModule } from "../ledger/ledger.module";
import { SqsIntegrationModule } from "../integration/sqs/sqs.module";
import { ChargesModule } from "../charges/charges.module";
import { CreditsModule } from "../credits/credits.module";
import { DualWriteModule } from "../migration/dual-write.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { CustomersModule } from "../customers/customers.module";
import { SurchargesModule } from "../surcharges/surcharges.module";
import { PaymentMethodsModule } from "../payment-methods/payment-methods.module";
import { ChargesService } from "../charges/charges.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { InvoicesRepository } from "./invoices.repository";
import {
  InvoicesService,
  CHARGES_SERVICE,
  SUBSCRIPTIONS_SERVICE_FOR_INVOICES,
} from "./invoices.service";
import { InvoicesController } from "./invoices.controller";

@Module({
  imports: [
    DatabaseModule,
    LedgerModule,
    CreditsModule,
    DualWriteModule,
    forwardRef(() => SubscriptionsModule),
    forwardRef(() => SqsIntegrationModule),
    forwardRef(() => ChargesModule),
    forwardRef(() => CustomersModule),
    forwardRef(() => SurchargesModule),
    forwardRef(() => PaymentMethodsModule),
  ],
  controllers: [InvoicesController],
  providers: [
    InvoicesRepository,
    InvoicesService,
    {
      provide: CHARGES_SERVICE,
      useExisting: ChargesService,
    },
    {
      provide: SUBSCRIPTIONS_SERVICE_FOR_INVOICES,
      useExisting: SubscriptionsService,
    },
  ],
  exports: [InvoicesRepository, InvoicesService],
})
export class InvoicesModule {}
