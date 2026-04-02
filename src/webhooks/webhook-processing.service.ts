import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { GatewayRegistry } from "../gateway/gateway.registry";
import { GatewayProvider } from "../common/enums/gateway-provider.enum";
import type {
  NormalizedWebhookEvent,
  NormalizedWebhookEventType,
} from "../common/interfaces/normalized-webhook-event.interface";
import {
  WEBHOOK_PAYMENT_SUCCEEDED,
  WEBHOOK_PAYMENT_FAILED,
  WEBHOOK_REFUND_COMPLETED,
} from "../common/constants/webhook-event-types";
import { LedgerService } from "../ledger/ledger.service";
import { SqsProducerService } from "../integration/sqs/sqs-producer.service";
import { IdempotencyService } from "../integration/sqs/idempotency.service";
import { ChargesRepository } from "../charges/charges.repository";
import { InvoicesRepository } from "../invoices/invoices.repository";
import { validateTransition } from "../common/utils/state-machine.util";
import {
  INVOICE_TRANSITIONS,
  type InvoiceStatus,
} from "../invoices/invoice-state-machine";
import type { StripeWebhookReceivedPayload } from "../integration/sqs/contracts/inbound-events";

/**
 * Fallback mapping from raw gateway event types to normalized types.
 * Used when adapter signature re-verification fails (defense-in-depth:
 * monolith already verified, SQS channel is IAM-secured).
 */
const STRIPE_FALLBACK_EVENT_MAP: Record<string, NormalizedWebhookEventType> = {
  "payment_intent.succeeded": WEBHOOK_PAYMENT_SUCCEEDED,
  "payment_intent.payment_failed": WEBHOOK_PAYMENT_FAILED,
  "charge.refunded": WEBHOOK_REFUND_COMPLETED,
};

const ADYEN_FALLBACK_EVENT_MAP: Record<string, NormalizedWebhookEventType> = {
  AUTHORISATION_SUCCESS: WEBHOOK_PAYMENT_SUCCEEDED,
  AUTHORISATION_FAILURE: WEBHOOK_PAYMENT_FAILED,
  REFUND: WEBHOOK_REFUND_COMPLETED,
};

export const SUBSCRIPTIONS_SERVICE_TOKEN = Symbol(
  "SUBSCRIPTIONS_SERVICE_WEBHOOK",
);

@Injectable()
export class WebhookProcessingService {
  private readonly logger = new Logger(WebhookProcessingService.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    private readonly gatewayRegistry: GatewayRegistry,
    private readonly ledgerService: LedgerService,
    private readonly sqsProducerService: SqsProducerService,
    private readonly idempotencyService: IdempotencyService,
    private readonly chargesRepository: ChargesRepository,
    private readonly invoicesRepository: InvoicesRepository,
    @Optional()
    @Inject(SUBSCRIPTIONS_SERVICE_TOKEN)
    private readonly subscriptionsService?: {
      advanceBillingPeriod: (
        subscriptionId: string,
        correlationId?: string,
      ) => Promise<unknown>;
    },
  ) {}

  async processWebhookEvent(
    payload: StripeWebhookReceivedPayload,
    correlationId: string,
    gatewayProvider: GatewayProvider = GatewayProvider.Stripe,
  ): Promise<void> {
    const { stripeEventId } = payload;
    const idempotencyType = `${gatewayProvider}.webhook`;

    // 1. Gateway event ID idempotency check (inner layer)
    const alreadyProcessed = await this.idempotencyService.isProcessed(
      stripeEventId,
      idempotencyType,
    );
    if (alreadyProcessed) {
      this.logger.debug({
        message: `Skipping duplicate ${gatewayProvider} event`,
        stripeEventId,
        correlationId,
      });
      return;
    }

    // 2. Verify and parse via gateway adapter (defense-in-depth)
    // Since the monolith already verified the signature and SQS is IAM-secured,
    // we attempt verification but fall back to manual construction if it fails
    let normalizedEvent: NormalizedWebhookEvent | null = null;

    try {
      const adapter = this.gatewayRegistry.getAdapter(gatewayProvider);
      normalizedEvent = await adapter.verifyAndParseWebhook(
        JSON.stringify(payload.data),
        { "stripe-signature": payload.signature },
      );
    } catch {
      // Log but do NOT return — monolith already verified, SQS channel is trusted
      this.logger.warn({
        message: `${gatewayProvider} webhook signature re-verification failed (monolith already verified, continuing)`,
        stripeEventId,
        type: payload.type,
        correlationId,
      });
      // Fall back to manual event construction from trusted SQS payload
      normalizedEvent = this.buildFallbackEvent(payload, gatewayProvider);
    }

    // 3. If null (unmapped event type), log and skip
    if (!normalizedEvent) {
      this.logger.warn({
        message: "Unsupported webhook event type",
        type: payload.type,
        stripeEventId,
        correlationId,
      });

      // Still mark as processed to avoid re-processing
      await this.idempotencyService.markProcessed(
        stripeEventId,
        idempotencyType,
      );
      return;
    }

    // 4. Route by normalized event type
    switch (normalizedEvent.eventType) {
      case WEBHOOK_PAYMENT_SUCCEEDED:
        await this.handlePaymentSucceeded(normalizedEvent, correlationId);
        break;
      case WEBHOOK_PAYMENT_FAILED:
        await this.handlePaymentFailed(normalizedEvent, correlationId);
        break;
      default:
        this.logger.warn({
          message: "Unhandled normalized event type",
          eventType: normalizedEvent.eventType,
          stripeEventId,
          correlationId,
        });
        break;
    }

    // 5. Mark gateway event ID as processed
    await this.idempotencyService.markProcessed(stripeEventId, idempotencyType);
  }

  private async handlePaymentSucceeded(
    event: NormalizedWebhookEvent,
    correlationId: string,
  ): Promise<void> {
    const paymentIntentId = event.gatewayChargeId;
    const gatewayEventId = event.gatewayEventId;

    // Find charge by stripe_payment_intent_id
    const charge =
      await this.chargesRepository.findByStripePaymentIntentId(paymentIntentId);

    if (!charge) {
      this.logger.warn({
        message:
          "No matching charge found for payment_intent.succeeded webhook",
        paymentIntentId,
        stripeEventId: gatewayEventId,
        correlationId,
      });
      return;
    }

    // Load associated invoice
    const invoice = await this.invoicesRepository.findById(charge.invoiceId);

    if (!invoice) {
      this.logger.warn({
        message: "Invoice not found for charge",
        chargeId: charge.id,
        invoiceId: charge.invoiceId,
        correlationId,
      });
      return;
    }

    // If invoice is already paid — no-op (idempotent)
    if (invoice.status === "paid") {
      this.logger.log({
        message: "Invoice already paid via webhook (no-op)",
        invoiceId: invoice.id,
        chargeId: charge.id,
        stripeEventId: gatewayEventId,
        correlationId,
      });
      return;
    }

    // If charge already succeeded (direct path completed first), skip to avoid duplicate processing
    if (charge.status === "succeeded") {
      this.logger.log({
        message: "Charge already succeeded via direct path (webhook no-op)",
        chargeId: charge.id,
        invoiceId: invoice.id,
        stripeEventId: gatewayEventId,
        correlationId,
      });
      return;
    }

    // If invoice is finalized — transition to paid
    if (invoice.status === "finalized") {
      await this.db.transaction(async (tx) => {
        // Update charge to succeeded (if still pending)
        await this.chargesRepository.updateStatus(
          charge.id,
          {
            status: "succeeded",
            updatedAt: new Date(),
          },
          tx,
        );

        // Validate and update invoice to paid
        validateTransition(
          invoice.status as InvoiceStatus,
          "paid" as InvoiceStatus,
          INVOICE_TRANSITIONS,
        );

        await this.invoicesRepository.update(
          invoice.id,
          {
            status: "paid",
            paidAt: new Date(),
            updatedAt: new Date(),
          },
          tx,
        );

        // Create ledger entry (debit cash, credit AR)
        await this.ledgerService.recordPaymentSucceeded(
          charge.id,
          invoice.totalAmountCents,
          invoice.currency,
          correlationId,
          tx,
        );
      });

      this.logger.log({
        message: "Payment succeeded via webhook",
        chargeId: charge.id,
        invoiceId: invoice.id,
        paymentIntentId,
        amountCents: invoice.totalAmountCents,
        correlationId,
      });

      // Advance subscription billing period (outside transaction)
      if (this.subscriptionsService && invoice.subscriptionId) {
        try {
          await this.subscriptionsService.advanceBillingPeriod(
            invoice.subscriptionId,
            correlationId,
          );
        } catch (advanceError) {
          this.logger.warn({
            message: "Failed to advance billing period after webhook payment",
            subscriptionId: invoice.subscriptionId,
            error:
              advanceError instanceof Error
                ? advanceError.message
                : String(advanceError),
            correlationId,
          });
        }
      }

      // Publish events (outside transaction)
      await this.sqsProducerService.publish(
        "payment.succeeded",
        {
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          amountCents: invoice.totalAmountCents,
          currency: invoice.currency,
          paymentMethodId: charge.paymentMethodId,
          stripePaymentIntentId: paymentIntentId,
        },
        correlationId,
      );

      await this.sqsProducerService.publish(
        "invoice.paid",
        {
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          totalAmountCents: invoice.totalAmountCents,
          currency: invoice.currency,
          paidAt: new Date().toISOString(),
        },
        correlationId,
      );
    } else {
      this.logger.warn({
        message:
          "Invoice in unexpected status for payment_intent.succeeded webhook",
        invoiceId: invoice.id,
        invoiceStatus: invoice.status,
        chargeId: charge.id,
        stripeEventId: gatewayEventId,
        correlationId,
      });
    }
  }

  private async handlePaymentFailed(
    event: NormalizedWebhookEvent,
    correlationId: string,
  ): Promise<void> {
    const paymentIntentId = event.gatewayChargeId;
    const gatewayEventId = event.gatewayEventId;

    // Extract failure reason from normalized metadata
    const failureReason =
      (event.metadata.failureMessage as string | undefined) ??
      "Payment failed (no error details)";

    // Find charge by stripe_payment_intent_id
    const charge =
      await this.chargesRepository.findByStripePaymentIntentId(paymentIntentId);

    if (!charge) {
      this.logger.warn({
        message:
          "No matching charge found for payment_intent.payment_failed webhook",
        paymentIntentId,
        stripeEventId: gatewayEventId,
        correlationId,
      });
      return;
    }

    // Load invoice for event payload data
    const invoice = await this.invoicesRepository.findById(charge.invoiceId);

    if (!invoice) {
      this.logger.warn({
        message: "Invoice not found for charge during payment failure handling",
        chargeId: charge.id,
        invoiceId: charge.invoiceId,
        correlationId,
      });
    }

    // Update charge to failed with failure reason
    await this.chargesRepository.updateStatus(charge.id, {
      status: "failed",
      failureReason,
      updatedAt: new Date(),
    });

    this.logger.log({
      message: "Payment failed via webhook",
      chargeId: charge.id,
      invoiceId: charge.invoiceId,
      paymentIntentId,
      failureReason,
      correlationId,
    });

    // Publish payment.failed event
    await this.sqsProducerService.publish(
      "payment.failed",
      {
        invoiceId: charge.invoiceId,
        customerId: charge.customerId,
        amountCents: invoice?.totalAmountCents ?? charge.amountCents,
        currency: invoice?.currency ?? charge.currency,
        failureReason,
        attemptNumber: charge.attemptNumber,
      },
      correlationId,
    );
  }

  /**
   * Defense-in-depth fallback: construct NormalizedWebhookEvent from trusted
   * SQS payload when adapter signature re-verification fails (expected when
   * monolith re-serializes JSON before forwarding via SQS).
   */
  private buildFallbackEvent(
    payload: StripeWebhookReceivedPayload,
    gatewayProvider: GatewayProvider,
  ): NormalizedWebhookEvent | null {
    if (gatewayProvider === GatewayProvider.Adyen) {
      return this.buildAdyenFallbackEvent(payload);
    }
    return this.buildStripeFallbackEvent(payload, gatewayProvider);
  }

  private buildStripeFallbackEvent(
    payload: StripeWebhookReceivedPayload,
    gatewayProvider: GatewayProvider,
  ): NormalizedWebhookEvent | null {
    const eventType = STRIPE_FALLBACK_EVENT_MAP[payload.type];
    if (!eventType) {
      return null;
    }

    const data = payload.data;
    const metadata: Record<string, unknown> =
      (data.metadata as Record<string, unknown>) ?? {};

    // For payment failures, extract error details into metadata
    if (eventType === WEBHOOK_PAYMENT_FAILED) {
      const lastPaymentError = data.last_payment_error as
        | Record<string, unknown>
        | null
        | undefined;
      if (lastPaymentError) {
        metadata.failureCode = lastPaymentError.code as string | undefined;
        metadata.failureMessage = lastPaymentError.message as
          | string
          | undefined;
      }
    }

    return {
      eventType,
      gatewayProvider,
      gatewayEventId: payload.stripeEventId,
      gatewayChargeId: data.id as string,
      amount: (data.amount as number) ?? 0,
      currency: ((data.currency as string) ?? "usd").toLowerCase(),
      status: (data.status as string) ?? "",
      metadata,
      receivedAt: new Date(),
    };
  }

  private buildAdyenFallbackEvent(
    payload: StripeWebhookReceivedPayload,
  ): NormalizedWebhookEvent | null {
    const data = payload.data;
    const notificationItems = data.notificationItems as
      | Array<{ NotificationRequestItem?: Record<string, unknown> }>
      | undefined;

    const item = notificationItems?.[0]?.NotificationRequestItem;
    if (!item) {
      return null;
    }

    const eventCode = item.eventCode as string;
    const success = String(item.success) === "true";
    const amount = item.amount as
      | { currency?: string; value?: number }
      | undefined;

    const lookupKey =
      eventCode === "AUTHORISATION"
        ? success
          ? "AUTHORISATION_SUCCESS"
          : "AUTHORISATION_FAILURE"
        : eventCode;

    const eventType = ADYEN_FALLBACK_EVENT_MAP[lookupKey];
    if (!eventType) {
      return null;
    }

    const metadata: Record<string, unknown> = {};
    if (!success) {
      const reason = (item.reason as string) ?? "Payment failed";
      metadata.failureCode = reason;
      metadata.failureMessage = reason;
    }

    return {
      eventType,
      gatewayProvider: GatewayProvider.Adyen,
      gatewayEventId: payload.stripeEventId,
      gatewayChargeId: (item.pspReference as string) ?? "",
      amount: amount?.value ?? 0,
      currency: (amount?.currency ?? "usd").toLowerCase(),
      status: success ? "succeeded" : "failed",
      metadata,
      receivedAt: new Date(),
    };
  }
}
