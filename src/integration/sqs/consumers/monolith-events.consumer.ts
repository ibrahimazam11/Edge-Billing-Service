import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { SqsMessageHandler, SqsConsumerEventHandler } from "@ssut/nestjs-sqs";
import type { Message as SqsMessage } from "@aws-sdk/client-sqs";
import * as Sentry from "@sentry/nestjs";
import type { SqsEnvelope } from "../../../common/interfaces/envelope.interface";
import { IdempotencyService } from "../idempotency.service";
import type { CustomersService } from "../../../customers/customers.service";
import type { SubscriptionsService } from "../../../subscriptions/subscriptions.service";
import type {
  CustomerCreatedPayload,
  CustomerUpdatedPayload,
  InvoiceCreatePayload,
  PayrollCalculatedPayload,
  SubscriptionCreatePayload,
  SurchargeConfigUpdatedPayload,
  StripeWebhookReceivedPayload,
  AdyenWebhookReceivedPayload,
} from "../contracts/inbound-events";
import type { InvoicesService } from "../../../invoices/invoices.service";
import { GatewayProvider } from "../../../common/enums/gateway-provider.enum";
import type { WebhookProcessingService } from "../../../webhooks/webhook-processing.service";
import type { SurchargeConfigService } from "../../../surcharges/surcharge-config.service";

export const CUSTOMERS_SERVICE = Symbol("CUSTOMERS_SERVICE");
export const SUBSCRIPTIONS_SERVICE = Symbol("SUBSCRIPTIONS_SERVICE");
export const INVOICES_SERVICE = Symbol("INVOICES_SERVICE_MONOLITH");
export const SURCHARGE_CONFIG_SERVICE = Symbol("SURCHARGE_CONFIG_SERVICE");
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
    @Optional()
    @Inject(SURCHARGE_CONFIG_SERVICE)
    private readonly surchargeConfigService?: SurchargeConfigService,
    @Optional()
    @Inject(INVOICES_SERVICE)
    private readonly invoicesService?: InvoicesService,
  ) {}

  @SqsMessageHandler("monolith-inbound", false)
  async handleMessage(message: SqsMessage): Promise<void> {
    let envelope: SqsEnvelope;
    try {
      envelope = JSON.parse(message.Body!) as SqsEnvelope;
    } catch (parseError) {
      this.logger.error({
        message: "Failed to parse SQS message body",
        messageId: message.MessageId,
      });
      Sentry.captureException(parseError, {
        tags: {
          queue: "monolith-inbound",
          stage: "json_parse",
          ...(message.MessageId ? { messageId: message.MessageId } : {}),
        },
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
      case "invoice.create":
        await this.handleInvoiceCreate(
          envelope.payload as InvoiceCreatePayload,
          correlationId,
        );
        break;
      case "payroll.calculated":
        await this.handlePayrollCalculated(
          envelope.payload as PayrollCalculatedPayload,
          correlationId,
        );
        break;
      case "subscription.create":
        await this.handleSubscriptionCreate(
          envelope.payload as SubscriptionCreatePayload,
          correlationId,
        );
        break;
      case "surcharge-config.updated":
        await this.handleSurchargeConfigUpdated(
          envelope.payload as SurchargeConfigUpdatedPayload,
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
    Sentry.captureException(error, {
      tags: {
        queue: "monolith-inbound",
        stage: "processing",
        ...(message.MessageId ? { messageId: message.MessageId } : {}),
      },
    });
  }

  @SqsConsumerEventHandler("monolith-inbound", "error")
  onError(error: Error): void {
    this.logger.error({
      message: "SQS error on monolith-inbound queue",
      error: error.message,
    });
    Sentry.captureException(error, {
      tags: { queue: "monolith-inbound", stage: "transport" },
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

  private async handleInvoiceCreate(
    payload: InvoiceCreatePayload,
    correlationId: string,
  ): Promise<void> {
    if (!this.customersService) {
      throw new Error(
        "CustomersService not available — cannot process invoice.create",
      );
    }
    if (!this.invoicesService) {
      throw new Error(
        "InvoicesService not available — cannot process invoice.create",
      );
    }

    const customer = await this.customersService.findByMonolithId(
      payload.monolithCustomerId,
    );

    if (!customer) {
      this.logger.warn({
        message: "Customer not found for invoice.create event",
        monolithCustomerId: payload.monolithCustomerId,
        correlationId,
      });
      return;
    }

    await this.invoicesService.createFromEvent(
      payload,
      customer.id,
      correlationId,
    );

    this.logger.log({
      message: "Invoice created from monolith event",
      customerId: customer.id,
      type: payload.type,
      totalAmountCents: payload.totalAmountCents,
      correlationId,
    });
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

    // Resolve the raw payroll state against the active subscription's cycle
    // anchor (BS owns billing rules now). updatePricing + invoice line item
    // update both happen inside applyPayrollUpdate.
    const totalAmountCents = await this.subscriptionsService.applyPayrollUpdate(
      customer.id,
      payload.employees,
      correlationId,
    );

    this.logger.log({
      message: "Payroll pricing and invoice line items updated",
      customerId: customer.id,
      employeeCount: payload.employees?.length ?? 0,
      totalAmountCents,
      correlationId,
    });
  }

  private async handleSubscriptionCreate(
    payload: SubscriptionCreatePayload,
    correlationId: string,
  ): Promise<void> {
    if (!this.customersService) {
      throw new Error(
        "CustomersService not available — cannot process subscription.create",
      );
    }
    if (!this.subscriptionsService) {
      throw new Error(
        "SubscriptionsService not available — cannot process subscription.create",
      );
    }

    const customer = await this.customersService.findByMonolithId(
      payload.monolithCustomerId,
    );

    if (!customer) {
      this.logger.warn({
        message: "Customer not found for subscription.create event",
        monolithCustomerId: payload.monolithCustomerId,
        correlationId,
      });
      return;
    }

    await this.subscriptionsService.createFromEvent(
      payload,
      customer.id,
      correlationId,
    );

    this.logger.log({
      message: "Subscription created from monolith event",
      customerId: customer.id,
      monolithCustomerId: payload.monolithCustomerId,
      correlationId,
    });
  }

  private async handleSurchargeConfigUpdated(
    payload: SurchargeConfigUpdatedPayload,
    correlationId: string,
  ): Promise<void> {
    if (!this.customersService) {
      throw new Error(
        "CustomersService not available — cannot process surcharge-config.updated",
      );
    }
    if (!this.surchargeConfigService) {
      throw new Error(
        "SurchargeConfigService not available — cannot process surcharge-config.updated",
      );
    }

    const customer = await this.customersService.findByMonolithId(
      payload.monolithCustomerId,
    );

    if (!customer) {
      this.logger.warn({
        message: "Customer not found for surcharge config event",
        monolithCustomerId: payload.monolithCustomerId,
        correlationId,
      });
      return;
    }

    await this.surchargeConfigService.upsertConfig(customer.id, {
      allowCreditCard: payload.allowCreditCard,
      surchargeType: payload.surchargeType,
      surchargeValue: payload.surchargeValue,
    });

    // Recalculate surcharge on open invoice after config change
    await this.invoicesService?.recalculateSurchargeOnOpenInvoice(
      customer.id,
      correlationId,
    );

    this.logger.log({
      message: "Surcharge config updated",
      customerId: customer.id,
      allowCreditCard: payload.allowCreditCard,
      correlationId,
    });
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
