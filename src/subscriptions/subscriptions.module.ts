import { Module, forwardRef } from "@nestjs/common";
import { CustomersModule } from "../customers/customers.module";
import { PaymentMethodsModule } from "../payment-methods/payment-methods.module";
import { SqsIntegrationModule } from "../integration/sqs/sqs.module";
import { MonolithApiModule } from "../integration/monolith-api/monolith-api.module";
import { DualWriteModule } from "../migration/dual-write.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { PayrollModule } from "../payroll/payroll.module";
import { SubscriptionsRepository } from "./subscriptions.repository";
import { SubscriptionsService } from "./subscriptions.service";
import { SubscriptionsController } from "./subscriptions.controller";

@Module({
  imports: [
    CustomersModule,
    forwardRef(() => PaymentMethodsModule),
    DualWriteModule,
    forwardRef(() => InvoicesModule),
    forwardRef(() => SqsIntegrationModule),
    MonolithApiModule,
    PayrollModule,
  ],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsRepository, SubscriptionsService],
  exports: [SubscriptionsRepository, SubscriptionsService],
})
export class SubscriptionsModule {}
