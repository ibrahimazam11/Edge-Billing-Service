import { Module, forwardRef } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { ChargesModule } from "../charges/charges.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { SqsIntegrationModule } from "../integration/sqs/sqs.module";
import { DualWriteModule } from "../migration/dual-write.module";
import { PaymentMethodsModule } from "../payment-methods/payment-methods.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { DunningService } from "./dunning.service";
import { DunningAttemptsRepository } from "./dunning.repository";

@Module({
  imports: [
    DatabaseModule,
    DualWriteModule,
    forwardRef(() => PaymentMethodsModule),
    forwardRef(() => InvoicesModule),
    forwardRef(() => ChargesModule),
    forwardRef(() => SubscriptionsModule),
    forwardRef(() => SqsIntegrationModule),
  ],
  providers: [DunningService, DunningAttemptsRepository],
  exports: [DunningService, DunningAttemptsRepository],
})
export class DunningModule {}
