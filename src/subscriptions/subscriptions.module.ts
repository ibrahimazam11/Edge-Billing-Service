import { Module, forwardRef } from "@nestjs/common";
import { CustomersModule } from "../customers/customers.module";
import { PaymentMethodsModule } from "../payment-methods/payment-methods.module";
import { SqsIntegrationModule } from "../integration/sqs/sqs.module";
import { DualWriteModule } from "../migration/dual-write.module";
import { SubscriptionsRepository } from "./subscriptions.repository";
import { SubscriptionsService } from "./subscriptions.service";
import { SubscriptionsController } from "./subscriptions.controller";

@Module({
  imports: [
    CustomersModule,
    PaymentMethodsModule,
    DualWriteModule,
    forwardRef(() => SqsIntegrationModule),
  ],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsRepository, SubscriptionsService],
  exports: [SubscriptionsRepository, SubscriptionsService],
})
export class SubscriptionsModule {}
