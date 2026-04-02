import { Module, forwardRef } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { GatewayModule } from "../gateway/gateway.module";
import { LedgerModule } from "../ledger/ledger.module";
import { SqsIntegrationModule } from "../integration/sqs/sqs.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ChargesModule } from "../charges/charges.module";
import { InvoicesModule } from "../invoices/invoices.module";
import {
  WebhookProcessingService,
  SUBSCRIPTIONS_SERVICE_TOKEN,
} from "./webhook-processing.service";

@Module({
  imports: [
    DatabaseModule,
    GatewayModule,
    LedgerModule,
    forwardRef(() => SqsIntegrationModule),
    forwardRef(() => SubscriptionsModule),
    forwardRef(() => ChargesModule),
    forwardRef(() => InvoicesModule),
  ],
  providers: [
    WebhookProcessingService,
    {
      provide: SUBSCRIPTIONS_SERVICE_TOKEN,
      useExisting: SubscriptionsService,
    },
  ],
  exports: [WebhookProcessingService],
})
export class WebhooksModule {}
