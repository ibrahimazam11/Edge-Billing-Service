import { Module, forwardRef } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { SqsModule as NestSqsModule } from "@ssut/nestjs-sqs";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { SqsOptions } from "@ssut/nestjs-sqs/dist/sqs.types";
import { SqsProducerService } from "./sqs-producer.service";
import { IdempotencyService } from "./idempotency.service";
import { ProcessedEventsRepository } from "./processed-events.repository";
import {
  MonolithEventsConsumer,
  CUSTOMERS_SERVICE,
  SUBSCRIPTIONS_SERVICE,
  WEBHOOK_PROCESSING_SERVICE,
} from "./consumers/monolith-events.consumer";
import {
  SchedulerEventsConsumer,
  INVOICES_SERVICE,
  DUNNING_SERVICE,
  RECONCILIATION_SERVICE,
} from "./consumers/scheduler-events.consumer";
import { CustomersModule } from "../../customers/customers.module";
import { CustomersService } from "../../customers/customers.service";
import { SubscriptionsModule } from "../../subscriptions/subscriptions.module";
import { SubscriptionsService } from "../../subscriptions/subscriptions.service";
import { InvoicesModule } from "../../invoices/invoices.module";
import { InvoicesService } from "../../invoices/invoices.service";
import { WebhooksModule } from "../../webhooks/webhooks.module";
import { WebhookProcessingService } from "../../webhooks/webhook-processing.service";
import { DunningModule } from "../../dunning/dunning.module";
import { DunningService } from "../../dunning/dunning.service";
import { ReconciliationModule } from "../../reconciliation/reconciliation.module";
import { ReconciliationService } from "../../reconciliation/reconciliation.service";

@Module({
  imports: [
    forwardRef(() => CustomersModule),
    forwardRef(() => SubscriptionsModule),
    forwardRef(() => InvoicesModule),
    forwardRef(() => WebhooksModule),
    forwardRef(() => DunningModule),
    forwardRef(() => ReconciliationModule),
    NestSqsModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): SqsOptions => {
        const accessKeyId = configService.get<string>("aws.accessKeyId");
        const secretAccessKey = configService.get<string>("aws.secretAccessKey");

        const sqsClient = new SQSClient({
          region: configService.get<string>("aws.region"),
          endpoint: configService.get<string>("aws.endpointUrl") || undefined,
          ...(accessKeyId && secretAccessKey
            ? { credentials: { accessKeyId, secretAccessKey } }
            : {}),
        });
        return {
          consumers: [
            {
              name: "monolith-inbound",
              queueUrl: configService.get<string>(
                "sqs.monolithInboundQueueUrl",
              )!,
              sqs: sqsClient,
            },
            {
              name: "scheduler-inbound",
              queueUrl: configService.get<string>("sqs.schedulerQueueUrl")!,
              sqs: sqsClient,
            },
          ],
          producers: [
            {
              name: "monolith-outbound",
              queueUrl: configService.get<string>(
                "sqs.monolithOutboundQueueUrl",
              )!,
              sqs: sqsClient,
            },
          ],
        };
      },
    }),
  ],
  providers: [
    SqsProducerService,
    ProcessedEventsRepository,
    IdempotencyService,
    MonolithEventsConsumer,
    SchedulerEventsConsumer,
    {
      provide: CUSTOMERS_SERVICE,
      useExisting: CustomersService,
    },
    {
      provide: SUBSCRIPTIONS_SERVICE,
      useExisting: SubscriptionsService,
    },
    {
      provide: INVOICES_SERVICE,
      useExisting: InvoicesService,
    },
    {
      provide: WEBHOOK_PROCESSING_SERVICE,
      useExisting: WebhookProcessingService,
    },
    {
      provide: DUNNING_SERVICE,
      useExisting: DunningService,
    },
    {
      provide: RECONCILIATION_SERVICE,
      useExisting: ReconciliationService,
    },
  ],
  exports: [SqsProducerService, IdempotencyService],
})
export class SqsIntegrationModule {}
