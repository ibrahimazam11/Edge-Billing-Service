import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { SqsMessageHandler, SqsConsumerEventHandler } from "@ssut/nestjs-sqs";
import type { Message as SqsMessage } from "@aws-sdk/client-sqs";
import type { SqsEnvelope } from "../../../common/interfaces/envelope.interface";
import { IdempotencyService } from "../idempotency.service";
import type { CustomersService } from "../../../customers/customers.service";
import type { SubscriptionsService } from "../../../subscriptions/subscriptions.service";
import type {
  CustomerCreatedPayload,
  CustomerUpdatedPayload,
  PayrollCalculatedPayload,
  StripeWebhookReceivedPayload,
  AdyenWebhookReceivedPayload,
} from "../contracts/inbound-events";
import { GatewayProvider } from "../../../common/enums/gateway-provider.enum";
import type { WebhookProcessingService } from "../../../webhooks/webhook-processing.service";

export const CUSTOMERS_SERVICE = Symbol("CUSTOMERS_SERVICE");
export const SUBSCRIPTIONS_SERVICE = Symbol("SUBSCRIPTIONS_SERVICE");
export const WEBHOOK_PROCESSING_SERVICE = Symbol("WEBHOOK_PROCESSING_SERVICE");

@Injectable()
export class MonolithEventsConsumer {
  private readonly logger = new Logger(MonolithEventsConsumer.name);

  constructor(
    private readonly idempotencyService: IdempotencyService,
    @Optional()
    @Inject(CUSTOMERS_SERVICE)
    private readonly customersService?: CustomersService,
    @Optional()
    @Inject(SUBSCRIPTIONS_SERVICE)
    private readonly subscriptionsService?: SubscriptionsService,
    @Optional()
    @Inject(WEBHOOK_PROCESSING_SERVICE)
    private readonly webhookProcessingService?: WebhookProcessingService,
  ) {}

  @SqsMessageHandler("monolith-inbound", false)
  async handleMessage(message: SqsMessage): Promise<void> {
    let envelope: SqsEnvelope;
    try {
      envelope = JSON.parse(message.Body!) as SqsEnvelope;
    } catch {
      this.logger.error({
        message: "Failed to parse SQS message body",
        messageId: message.MessageId,
      });
      return;
    }

    const version = envelope.version as string;
    if (version !== "1.0") {
      this.logger.warn({
        message: "Unsupported envelope version",
        version,
        eventId: message.MessageId,
      });
      return;
    }

    const { correlationId, type } = envelope;
    const eventId = message.MessageId!;

    const alreadyProcessed = await this.idempotencyService.isProcessed(
      eventId,
      type,
    );
    if (alreadyProcessed) {
      this.logger.debug({
        message: "Skipping duplicate event",
        eventId,
        eventType: type,
        correlationId,
      });
      return;
    }

    this.logger.log({
      message: "Processing monolith event",
      eventType: type,
      correlationId,
    });

    switch (type) {
      case "customer.created":
        await this.handleCustomerCreated(
          envelope.payload as CustomerCreatedPayload,
          correlationId,
        );
        break;
      case "customer.updated":
        await this.handleCustomerUpdated(
          envelope.payload as CustomerUpdatedPayload,
          correlationId,
        );
        break;
      case "payroll.calculated":
        await this.handlePayrollCalculated(
          envelope.payload as PayrollCalculatedPayload,
          correlationId,
        );
        break;
      case "stripe.webhook.received":
        await this.handleStripeWebhookReceived(
          envelope.payload as StripeWebhookReceivedPayload,
          correlationId,
        );
        break;
      case "adyen.webhook.received":
        await this.handleAdyenWebhookReceived(
          envelope.payload as AdyenWebhookReceivedPayload,
          correlationId,
        );
        break;
      default:
        this.logger.warn({
          message: "Unknown monolith event type",
          eventType: type,
          correlationId,
        });
        return;
    }

    await this.idempotencyService.markProcessed(eventId, type);
  }

  @SqsConsumerEventHandler("monolith-inbound", "processing_error")
  onProcessingError(error: Error, message: SqsMessage): void {
    this.logger.error({
      message: "Error processing monolith event",
      error: error.message,
      messageId: message.MessageId,
    });
  }

  @SqsConsumerEventHandler("monolith-inbound", "error")
  onError(error: Error): void {
    this.logger.error({
      message: "SQS error on monolith-inbound queue",
      error: error.message,
    });
  }

  private async handleCustomerCreated(
    payload: CustomerCreatedPayload,
    correlationId: string,
  ): Promise<void> {
    if (!this.customersService) {
      throw new Error(
        "CustomersService not available — cannot process customer.created",
      );
    }
    await this.customersService.createFromEvent(payload, correlationId);
  }

  private async handleCustomerUpdated(
    payload: CustomerUpdatedPayload,
    correlationId: string,
  ): Promise<void> {
    if (!this.customersService) {
      throw new Error(
        "CustomersService not available — cannot process customer.updated",
      );
    }
    await this.customersService.updateFromEvent(payload, correlationId);
  }

  private async handlePayrollCalculated(
    payload: PayrollCalculatedPayload,
    correlationId: string,
  ): Promise<void> {
    if (!this.customersService) {
      throw new Error(
        "CustomersService not available — cannot process payroll.calculated",
      );
    }

    const customer = await this.customersService.findByMonolithId(
      payload.monolithCustomerId,
    );

    if (!customer) {
      this.logger.warn({
        message: "Customer not found for payroll event",
        monolithCustomerId: payload.monolithCustomerId,
        correlationId,
      });
      return;
    }

    if (!this.subscriptionsService) {
      throw new Error(
        "SubscriptionsService not available — cannot process payroll.calculated",
      );
    }

    const updatedCount = await this.subscriptionsService.updatePricing(
      customer.id,
      payload.amountCents,
      correlationId,
    );

    if (updatedCount === 0) {
      this.logger.warn({
        message: "No active/paused subscriptions found for pricing update",
        customerId: customer.id,
        correlationId,
      });
    } else {
      this.logger.log({
        message: "Payroll pricing update applied",
        customerId: customer.id,
        updatedCount,
        correlationId,
      });
    }
  }

  private async handleStripeWebhookReceived(
    payload: StripeWebhookReceivedPayload,
    correlationId: string,
  ): Promise<void> {
    if (!this.webhookProcessingService) {
      throw new Error(
        "WebhookProcessingService not available — cannot process stripe.webhook.received",
      );
    }
    await this.webhookProcessingService.processWebhookEvent(
      payload,
      correlationId,
    );
  }

  private async handleAdyenWebhookReceived(
    payload: AdyenWebhookReceivedPayload,
    correlationId: string,
  ): Promise<void> {
    if (!this.webhookProcessingService) {
      throw new Error(
        "WebhookProcessingService not available — cannot process adyen.webhook.received",
      );
    }

    // Map Adyen payload to StripeWebhookReceivedPayload shape for unified processing
    const webhookPayload: StripeWebhookReceivedPayload = {
      stripeEventId: payload.adyenEventId,
      type: "adyen.webhook",
      data: JSON.parse(payload.rawPayload) as Record<string, unknown>,
      signature: "",
    };

    await this.webhookProcessingService.processWebhookEvent(
      webhookPayload,
      correlationId,
      GatewayProvider.Adyen,
    );
  }
}
