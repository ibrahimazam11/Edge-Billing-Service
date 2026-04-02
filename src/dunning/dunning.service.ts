import {
  Inject,
  Injectable,
  Logger,
  Optional,
  forwardRef,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { generateId } from "../common/utils/uuid.util";
import { ChargesService } from "../charges/charges.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import type { UpdateSubscriptionDto } from "../subscriptions/dto/update-subscription.dto";
import { SqsProducerService } from "../integration/sqs/sqs-producer.service";
import { DualWriteService } from "../migration/dual-write.service";
import { PaymentMethodsService } from "../payment-methods/payment-methods.service";
import { InvoiceAlreadyPaidException } from "../charges/invoice-already-paid.exception";
import { DunningAttemptsRepository } from "./dunning.repository";
import { InvoicesRepository } from "../invoices/invoices.repository";

export type DunningAttemptStatus =
  | "scheduled"
  | "succeeded"
  | "failed"
  | "skipped";

export interface DunningAttempt {
  id: string;
  invoiceId: string;
  chargeId: string | null;
  paymentMethodId: string | null;
  attemptNumber: number;
  scheduledDate: Date;
  executedAt: Date | null;
  status: DunningAttemptStatus;
  failureReason: string | null;
  createdAt: Date;
}

export interface ExecuteDunningResult {
  status: "succeeded" | "failed" | "skipped";
  chargeId?: string;
  failureReason?: string;
}

@Injectable()
export class DunningService {
  private readonly logger = new Logger(DunningService.name);
  private readonly retryScheduleDays: number[];
  private readonly maxRetryAttempts: number;

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    private readonly configService: ConfigService,
    private readonly dunningRepo: DunningAttemptsRepository,
    private readonly invoicesRepo: InvoicesRepository,
    @Optional()
    @Inject(forwardRef(() => ChargesService))
    private readonly chargesService?: ChargesService,
    @Optional()
    @Inject(forwardRef(() => SubscriptionsService))
    private readonly subscriptionsService?: SubscriptionsService,
    @Optional()
    @Inject(forwardRef(() => SqsProducerService))
    private readonly sqsProducerService?: SqsProducerService,
    @Optional()
    private readonly dualWriteService?: DualWriteService,
    @Optional()
    private readonly paymentMethodsService?: PaymentMethodsService,
  ) {
    const schedule = this.configService.get<number[]>(
      "dunning.retryScheduleDays",
    );
    if (!schedule) {
      throw new Error(
        "Dunning configuration not loaded: dunning.retryScheduleDays is missing",
      );
    }
    this.retryScheduleDays = schedule;
    this.maxRetryAttempts =
      this.configService.get<number>("dunning.maxRetryAttempts") ??
      schedule.length;
  }

  async executeDunningAttempt(
    attemptId: string,
    correlationId: string,
  ): Promise<ExecuteDunningResult> {
    if (!this.chargesService) {
      throw new Error(
        "ChargesService is not available — cannot execute dunning attempt",
      );
    }

    // 1. Load the dunning attempt and verify status is scheduled
    const attempt = await this.dunningRepo.findById(attemptId);

    if (!attempt) {
      throw new Error(`Dunning attempt not found: ${attemptId}`);
    }

    if (attempt.status !== "scheduled") {
      this.logger.warn({
        message: "Dunning attempt is not in scheduled status, skipping",
        dunningAttemptId: attemptId,
        currentStatus: attempt.status,
        correlationId,
      });
      return { status: "skipped" };
    }

    // 2. Load the invoice and check if already paid or void
    const invoice = await this.invoicesRepo.findById(attempt.invoiceId);

    if (!invoice) {
      throw new Error(
        `Invoice not found for dunning attempt: ${attempt.invoiceId}`,
      );
    }

    if (invoice.status === "paid" || invoice.status === "void") {
      this.logger.log({
        message: "Invoice is no longer finalized, skipping dunning attempt",
        dunningAttemptId: attemptId,
        invoiceId: attempt.invoiceId,
        invoiceStatus: invoice.status,
        correlationId,
      });

      // Atomically mark current attempt as skipped and skip remaining
      await this.db.transaction(async (tx) => {
        await this.dunningRepo.updateStatus(
          attemptId,
          { status: "skipped" },
          tx,
        );
        await this.dunningRepo.markRemainingAsSkipped(attempt.invoiceId, tx);
      });
      return { status: "skipped" };
    }

    // 3. Select payment method for this attempt
    const selectedPmId = await this.selectPaymentMethodForAttempt(
      invoice.customerId,
      attempt.invoiceId,
      attemptId,
      correlationId,
    );

    // null means escalation was handled (no PM available or all exhausted)
    if (selectedPmId === null) {
      return {
        status: "failed",
        failureReason: "all_payment_methods_exhausted",
      };
    }

    // 4. Execute the charge via ChargesService with selected PM
    let chargeResult: {
      chargeId: string;
      status: string;
      stripePaymentIntentId: string | null;
      failureReason?: string;
    };
    try {
      chargeResult = await this.chargesService.executePaymentForInvoice(
        attempt.invoiceId,
        correlationId,
        attempt.attemptNumber,
        selectedPmId,
      );
    } catch (error) {
      // If invoice was already paid between our check and the charge attempt
      if (error instanceof InvoiceAlreadyPaidException) {
        this.logger.log({
          message:
            "Invoice already paid during charge execution, marking as skipped",
          dunningAttemptId: attemptId,
          invoiceId: attempt.invoiceId,
          correlationId,
        });

        // Atomically mark current attempt as skipped and skip remaining
        await this.db.transaction(async (tx) => {
          await this.dunningRepo.updateStatus(
            attemptId,
            { status: "skipped" },
            tx,
          );
          await this.dunningRepo.markRemainingAsSkipped(attempt.invoiceId, tx);
        });
        return { status: "skipped" };
      }
      throw error;
    }

    // 4. Handle success or failure — single atomic UPDATE per branch
    const now = new Date();

    if (chargeResult.status === "succeeded") {
      await this.db.transaction(async (tx) => {
        await this.dunningRepo.updateStatus(
          attemptId,
          {
            executedAt: now,
            chargeId: chargeResult.chargeId,
            status: "succeeded",
            paymentMethodId: selectedPmId,
          },
          tx,
        );
        await this.dunningRepo.markRemainingAsSkipped(attempt.invoiceId, tx);
      });

      this.logger.log({
        message: "Dunning attempt succeeded",
        dunningAttemptId: attemptId,
        invoiceId: attempt.invoiceId,
        chargeId: chargeResult.chargeId,
        attemptNumber: attempt.attemptNumber,
        correlationId,
      });

      return {
        status: "succeeded",
        chargeId: chargeResult.chargeId,
      };
    }

    // Failure path — use real failure reason from ChargesService
    const failureReason = chargeResult.failureReason ?? "Charge failed";

    // Atomically update attempt status and schedule next retry (if available)
    let hasNext = false;
    await this.db.transaction(async (tx) => {
      await this.dunningRepo.updateStatus(
        attemptId,
        {
          executedAt: now,
          chargeId: chargeResult.chargeId,
          status: "failed",
          failureReason,
          paymentMethodId: selectedPmId,
        },
        tx,
      );

      hasNext = await this.scheduleNextDunningAttempt(
        attempt.invoiceId,
        attempt.attemptNumber,
        correlationId,
        tx,
      );
    });

    this.logger.warn({
      message: "Dunning attempt failed",
      dunningAttemptId: attemptId,
      invoiceId: attempt.invoiceId,
      attemptNumber: attempt.attemptNumber,
      failureReason,
      correlationId,
    });

    // Escalate outside transaction (involves external service calls)
    if (!hasNext) {
      await this.escalateDunning(invoice, correlationId);
    }

    return {
      status: "failed",
      chargeId: chargeResult.chargeId,
      failureReason,
    };
  }

  /**
   * Select the payment method to use for a dunning attempt.
   * Returns the PM ID to charge, or null if escalation was handled inline.
   */
  private async selectPaymentMethodForAttempt(
    customerId: string,
    invoiceId: string,
    attemptId: string,
    correlationId: string,
  ): Promise<string | null> {
    if (!this.paymentMethodsService) {
      throw new Error(
        "PaymentMethodsService is not available — cannot select payment method",
      );
    }

    const orderedPms =
      await this.paymentMethodsService.getOrderedPaymentMethods(customerId);

    // No active PMs — mark failed and escalate
    if (orderedPms.length === 0) {
      this.logger.warn(
        `Dunning PM selection: invoiceId=${invoiceId}, customerId=${customerId}, availablePMs=0, escalating=true`,
      );

      await this.dunningRepo.updateStatus(attemptId, {
        status: "failed",
        executedAt: new Date(),
        failureReason: "no_active_payment_methods",
      });

      // Skip remaining scheduled attempts
      await this.dunningRepo.markRemainingAsSkipped(invoiceId);

      // Load invoice for escalation
      const invoice = await this.invoicesRepo.findById(invoiceId);

      if (invoice) {
        await this.escalateDunning(invoice, correlationId);
      }

      return null;
    }

    // Single PM — always use it (backward compatible, no history filtering)
    if (orderedPms.length === 1) {
      const pm = orderedPms[0];
      this.logger.log(
        `Dunning PM selection: invoiceId=${invoiceId}, customerId=${customerId}, availablePMs=1, selectedPM=${pm.id}`,
      );
      return pm.id;
    }

    // Multiple PMs — cascade through untried PMs
    const history = await this.getDunningAttemptsForInvoice(invoiceId);
    const triedPmIds = new Set(
      history
        .filter((a) => a.paymentMethodId && a.status === "failed")
        .map((a) => a.paymentMethodId),
    );

    const untried = orderedPms.filter((pm) => !triedPmIds.has(pm.id));

    if (untried.length === 0) {
      // All PMs exhausted — mark failed and escalate
      this.logger.warn(
        `Dunning PM selection: invoiceId=${invoiceId}, customerId=${customerId}, availablePMs=${orderedPms.length}, triedPMs=${triedPmIds.size}, escalating=true`,
      );

      await this.dunningRepo.updateStatus(attemptId, {
        status: "failed",
        executedAt: new Date(),
        failureReason: "all_payment_methods_exhausted",
      });

      // Skip remaining scheduled attempts
      await this.dunningRepo.markRemainingAsSkipped(invoiceId);

      // Load invoice for escalation
      const invoice = await this.invoicesRepo.findById(invoiceId);

      if (invoice) {
        await this.escalateDunning(invoice, correlationId);
      }

      return null;
    }

    const selectedPm = untried[0];
    this.logger.log(
      `Dunning PM selection: invoiceId=${invoiceId}, customerId=${customerId}, availablePMs=${orderedPms.length}, selectedPM=${selectedPm.id}`,
    );
    return selectedPm.id;
  }

  private async scheduleNextDunningAttempt(
    invoiceId: string,
    currentAttemptNumber: number,
    correlationId: string,
    tx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<boolean> {
    const nextAttemptNumber = currentAttemptNumber + 1;

    if (nextAttemptNumber > this.maxRetryAttempts) {
      this.logger.log({
        message: "All dunning retries exhausted",
        invoiceId,
        currentAttemptNumber,
        maxRetryAttempts: this.maxRetryAttempts,
        correlationId,
      });
      return false;
    }

    const scheduleIndex = nextAttemptNumber - 1;
    const daysToAdd =
      scheduleIndex < this.retryScheduleDays.length
        ? this.retryScheduleDays[scheduleIndex]
        : this.retryScheduleDays[this.retryScheduleDays.length - 1];

    const scheduledDate = new Date();
    scheduledDate.setDate(scheduledDate.getDate() + daysToAdd);

    const id = generateId();

    await this.dunningRepo.insert(
      {
        id,
        invoiceId,
        attemptNumber: nextAttemptNumber,
        scheduledDate,
        status: "scheduled",
      },
      tx,
    );

    this.logger.log({
      message: "Next dunning attempt scheduled",
      dunningAttemptId: id,
      invoiceId,
      attemptNumber: nextAttemptNumber,
      scheduledDate: scheduledDate.toISOString(),
      correlationId,
    });

    return true;
  }

  private async escalateDunning(
    invoice: {
      id: string;
      customerId: string;
      subscriptionId: string | null;
      totalAmountCents: number;
      currency: string;
    },
    correlationId: string,
  ): Promise<void> {
    const invoiceId = invoice.id;

    // Load full attempt history
    const attempts = await this.getDunningAttemptsForInvoice(invoiceId);

    const failureHistory = attempts
      .filter((a) => a.status === "failed")
      .map((a) => ({
        attemptNumber: a.attemptNumber,
        failedAt: a.executedAt
          ? a.executedAt.toISOString()
          : new Date().toISOString(),
        reason: a.failureReason ?? "Unknown",
      }));

    // Transition subscription to past_due if applicable
    if (invoice.subscriptionId && this.subscriptionsService) {
      try {
        await this.subscriptionsService.updateState(
          invoice.subscriptionId,
          { status: "past_due" } as unknown as UpdateSubscriptionDto,
          correlationId,
        );
      } catch (error) {
        this.logger.warn({
          message:
            "Failed to transition subscription to past_due during dunning escalation",
          subscriptionId: invoice.subscriptionId,
          error: error instanceof Error ? error.message : String(error),
          correlationId,
        });
      }
    }

    // Publish dunning.escalated event
    if (this.sqsProducerService) {
      const dualWriteMetadata =
        await this.dualWriteService?.getDualWriteMetadata(invoice.customerId);

      try {
        await this.sqsProducerService.publish(
          "dunning.escalated",
          {
            invoiceId,
            customerId: invoice.customerId,
            totalAttempts: attempts.length,
            failureHistory,
            amountCents: invoice.totalAmountCents,
            currency: invoice.currency,
          },
          correlationId,
          dualWriteMetadata,
        );
      } catch (error) {
        if (dualWriteMetadata) {
          await this.dualWriteService?.logDualWriteFailure(
            invoice.customerId,
            "dunning.escalated",
            { invoiceId, amountCents: invoice.totalAmountCents },
            error,
            correlationId,
          );
        } else {
          this.logger.error({
            message: "Failed to publish dunning.escalated event",
            invoiceId,
            error: error instanceof Error ? error.message : String(error),
            correlationId,
          });
        }
      }
    }

    this.logger.log({
      invoiceId,
      customerId: invoice.customerId,
      totalAttempts: attempts.length,
      action: "dunning.escalated",
    });
  }

  async scheduleDunningAttempt(
    invoiceId: string,
    correlationId?: string,
  ): Promise<void> {
    // Check for existing non-skipped dunning attempts to avoid duplicate dunning chains
    const existing = await this.dunningRepo.findExistingNonSkipped(invoiceId);

    if (existing.length > 0) {
      this.logger.debug({
        message: "Dunning already exists for invoice, skipping",
        invoiceId,
        existingAttempts: existing.length,
        correlationId,
      });
      return;
    }

    const scheduledDate = new Date();
    scheduledDate.setDate(scheduledDate.getDate() + this.retryScheduleDays[0]);

    const id = generateId();

    await this.dunningRepo.insert({
      id,
      invoiceId,
      attemptNumber: 1,
      scheduledDate,
      status: "scheduled",
    });

    this.logger.log({
      message: "Dunning attempt scheduled",
      dunningAttemptId: id,
      invoiceId,
      attemptNumber: 1,
      scheduledDate: scheduledDate.toISOString(),
      correlationId,
    });
  }

  async getScheduledDunningAttempts(): Promise<DunningAttempt[]> {
    const results = await this.dunningRepo.findScheduled();

    this.logger.debug({
      message: "Queried scheduled dunning attempts",
      dueCount: results.length,
    });

    return results.map((r) => ({
      id: r.id,
      invoiceId: r.invoiceId,
      chargeId: r.chargeId,
      paymentMethodId: r.paymentMethodId ?? null,
      attemptNumber: r.attemptNumber,
      scheduledDate: r.scheduledDate,
      executedAt: r.executedAt,
      status: r.status as DunningAttemptStatus,
      failureReason: r.failureReason,
      createdAt: r.createdAt,
    }));
  }

  async getDunningAttemptsForInvoice(
    invoiceId: string,
  ): Promise<DunningAttempt[]> {
    const results = await this.dunningRepo.findByInvoiceId(invoiceId);

    return results.map((r) => ({
      id: r.id,
      invoiceId: r.invoiceId,
      chargeId: r.chargeId,
      paymentMethodId: r.paymentMethodId ?? null,
      attemptNumber: r.attemptNumber,
      scheduledDate: r.scheduledDate,
      executedAt: r.executedAt,
      status: r.status as DunningAttemptStatus,
      failureReason: r.failureReason,
      createdAt: r.createdAt,
    }));
  }
}
