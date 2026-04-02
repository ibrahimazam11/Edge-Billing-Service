import { Module, forwardRef } from "@nestjs/common";
import { RefundsService } from "./refunds.service";
import { RefundsRepository } from "./refunds.repository";
import { RefundsController } from "./refunds.controller";
import { DatabaseModule } from "../database/database.module";
import { GatewayModule } from "../gateway/gateway.module";
import { LedgerModule } from "../ledger/ledger.module";
import { SqsIntegrationModule } from "../integration/sqs/sqs.module";
import { ChargesModule } from "../charges/charges.module";
import { PaymentMethodsModule } from "../payment-methods/payment-methods.module";

@Module({
  imports: [
    DatabaseModule,
    GatewayModule,
    LedgerModule,
    forwardRef(() => SqsIntegrationModule),
    ChargesModule,
    PaymentMethodsModule,
  ],
  controllers: [RefundsController],
  providers: [RefundsService, RefundsRepository],
  exports: [RefundsService, RefundsRepository],
})
export class RefundsModule {}
