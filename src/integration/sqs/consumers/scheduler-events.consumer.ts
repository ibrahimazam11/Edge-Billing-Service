import { Injectable, Logger, Optional, Inject } from "@nestjs/common";
import { SqsMessageHandler, SqsConsumerEventHandler } from "@ssut/nestjs-sqs";
import type { Message as SqsMessage } from "@aws-sdk/client-sqs";
import type { SqsEnvelope } from "../../../common/interfaces/envelope.interface";
import { IdempotencyService } from "../idempotency.service";
import type {
  BillingScheduleGenerateInvoicesPayload,
  BillingScheduleProcessDunningPayload,
  BillingScheduleDailyReconciliationPayload,
} from "../contracts/inbound-events";
import type { InvoicesService } from "../../../invoices/invoices.service";
import type { DunningService } from "../../../dunning/dunning.service";
import type { ReconciliationService } from "../../../reconciliation/reconciliation.service";

export const INVOICES_SERVICE = Symbol("INVOICES_SERVICE");
export const DUNNING_SERVICE = Symbol("DUNNING_SERVICE");
export const RECONCILIATION_SERVICE = Symbol("RECONCILIATION_SERVICE");

@Injectable()
export class SchedulerEventsConsumer {
  private readonly logger = new Logger(SchedulerEventsConsumer.name);

  constructor(
    private readonly idempotencyService: IdempotencyService,
    @Optional()
    @Inject(INVOICES_SERVICE)
    private readonly invoicesService?: InvoicesService,
    @Optional()
    @Inject(DUNNING_SERVICE)
    private readonly dunningService?: DunningService,
    @Optional()
    @Inject(RECONCILIATION_SERVICE)
    private readonly reconciliationService?: ReconciliationService,
  ) {}

  @SqsMessageHandler("scheduler-inbound", false)
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
        message: "Skipping duplicate scheduler event",
        eventId,
        eventType: type,
        correlationId,
      });
      return;
    }

    this.logger.log({
      message: "Processing scheduler event",
      eventType: type,
      correlationId,
    });

    switch (type) {
      case "billing.schedule.generate-invoices":
        await this.handleGenerateInvoices(
          envelope.payload as BillingScheduleGenerateInvoicesPayload,
          correlationId,
        );
        break;
      case "billing.schedule.process-dunning":
        await this.handleProcessDunning(
          envelope.payload as BillingScheduleProcessDunningPayload,
          correlationId,
        );
        break;
      case "billing.schedule.daily-reconciliation":
        await this.handleDailyReconciliation(
          envelope.payload as BillingScheduleDailyReconciliationPayload,
          correlationId,
        );
        break;
      default:
        this.logger.warn({
          message: "Unknown scheduler event type",
          eventType: type,
          correlationId,
        });
        return;
    }

    await this.idempotencyService.markProcessed(eventId, type);
  }

  @SqsConsumerEventHandler("scheduler-inbound", "processing_error")
  onProcessingError(error: Error, message: SqsMessage): void {
    this.logger.error({
      message: "Error processing scheduler event",
      error: error.message,
      messageId: message.MessageId,
    });
  }

  @SqsConsumerEventHandler("scheduler-inbound", "error")
  onError(error: Error): void {
    this.logger.error({
      message: "SQS error on scheduler-inbound queue",
      error: error.message,
    });
  }

  private async handleGenerateInvoices(
    payload: BillingScheduleGenerateInvoicesPayload,
    correlationId: string,
  ): Promise<void> {
    if (!this.invoicesService) {
      this.logger.warn({
        message: "InvoicesService not available",
        correlationId,
      });
      return;
    }
    const result =
      await this.invoicesService.generateInvoicesForDueSubscriptions(
        payload.scheduledDate,
        correlationId,
      );
    this.logger.log({
      message: "Invoice generation completed",
      invoicesCreated: result.created,
      subscriptionsSkipped: result.skipped,
      correlationId,
    });
  }

  private async handleProcessDunning(
    _payload: BillingScheduleProcessDunningPayload,
    correlationId: string,
  ): Promise<void> {
    if (!this.dunningService) {
      this.logger.warn({
        message: "DunningService not available",
        correlationId,
      });
      return;
    }

    const dueAttempts = await this.dunningService.getScheduledDunningAttempts();

    if (dueAttempts.length === 0) {
      this.logger.debug({
        message: "No dunning attempts due for processing",
        correlationId,
      });
      return;
    }

    this.logger.log({
      message: "Processing due dunning attempts",
      dueCount: dueAttempts.length,
      correlationId,
    });

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const attempt of dueAttempts) {
      try {
        const result = await this.dunningService.executeDunningAttempt(
          attempt.id,
          correlationId,
        );

        if (result.status === "succeeded") succeeded++;
        else if (result.status === "failed") failed++;
        else skipped++;
      } catch (error) {
        failed++;
        this.logger.error({
          message: "Dunning attempt execution error",
          dunningAttemptId: attempt.id,
          invoiceId: attempt.invoiceId,
          error: error instanceof Error ? error.message : String(error),
          correlationId,
        });
      }
    }

    this.logger.log({
      message: "Dunning processing completed",
      total: dueAttempts.length,
      succeeded,
      failed,
      skipped,
      correlationId,
    });
  }

  private async handleDailyReconciliation(
    payload: BillingScheduleDailyReconciliationPayload,
    correlationId: string,
  ): Promise<void> {
    if (!this.reconciliationService) {
      this.logger.warn({
        message: "ReconciliationService not available",
        correlationId,
      });
      return;
    }

    // Parse period from payload — default to previous day midnight-to-midnight UTC
    let periodStart: Date;
    let periodEnd: Date;

    if (payload.periodStart && payload.periodEnd) {
      periodStart = new Date(payload.periodStart);
      periodEnd = new Date(payload.periodEnd);
    } else {
      const scheduledDate = new Date(payload.scheduledDate);
      periodStart = new Date(
        Date.UTC(
          scheduledDate.getUTCFullYear(),
          scheduledDate.getUTCMonth(),
          scheduledDate.getUTCDate() - 1,
        ),
      );
      periodEnd = new Date(
        Date.UTC(
          scheduledDate.getUTCFullYear(),
          scheduledDate.getUTCMonth(),
          scheduledDate.getUTCDate(),
        ),
      );
    }

    const result = await this.reconciliationService.runDailyReconciliation(
      periodStart,
      periodEnd,
      correlationId,
    );

    this.logger.log({
      message: "Daily reconciliation completed",
      runId: result.id,
      status: result.status,
      recordsCompared: result.recordsCompared,
      correlationId,
    });
  }
}
