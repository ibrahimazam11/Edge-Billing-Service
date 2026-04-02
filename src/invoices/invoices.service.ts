import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { LedgerService } from "../ledger/ledger.service";
import { CreditsService } from "../credits/credits.service";
import { SqsProducerService } from "../integration/sqs/sqs-producer.service";
import { SubscriptionsRepository } from "../subscriptions/subscriptions.repository";
import { subscriptions } from "../database/schema/subscriptions";
import { generateId } from "../common/utils/uuid.util";
import { validateTransition } from "../common/utils/state-machine.util";
import { StateTransitionException } from "../common/exceptions/billing.exception";
import type { CreditApplicationResult } from "../credits/credits.service";
import {
  INVOICE_TRANSITIONS,
  type InvoiceStatus,
} from "./invoice-state-machine";
import { DualWriteService } from "../migration/dual-write.service";
import { InvoiceNotFoundException } from "./invoice-not-found.exception";
import { InvoiceAlreadyPaidException } from "./exceptions/invoice-already-paid.exception";
import { InvoiceNotFinalizedException } from "./exceptions/invoice-not-finalized.exception";
import { InvoiceAlreadyVoidedException } from "./exceptions/invoice-already-voided.exception";
import type { PaginatedResult } from "../common/dto/pagination.dto";
import type { InvoiceResponseDto } from "./dto/invoice-response.dto";
import type { InvoiceLineItemResponseDto } from "./dto/invoice-line-item-response.dto";
import type { InvoiceQueryDto } from "./dto/invoice-query.dto";
import type { ChargeResultDto } from "../charges/dto/charge-result.dto";
import { InvoicesRepository } from "./invoices.repository";
import { invoices } from "../database/schema/invoices";
import { invoiceLineItems } from "../database/schema/invoice-line-items";

export const CHARGES_SERVICE = Symbol("CHARGES_SERVICE");

export interface GenerationResult {
  created: number;
  skipped: number;
  finalized: number;
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    private readonly invoicesRepository: InvoicesRepository,
    private readonly subscriptionsRepository: SubscriptionsRepository,
    private readonly ledgerService: LedgerService,
    private readonly sqsProducerService: SqsProducerService,
    @Optional() private readonly creditsService?: CreditsService,
    @Optional()
    @Inject(CHARGES_SERVICE)
    private readonly chargesService?: {
      executePaymentForInvoice: (
        invoiceId: string,
        correlationId: string,
        attemptNumber?: number,
      ) => Promise<ChargeResultDto>;
    },
    @Optional()
    private readonly dualWriteService?: DualWriteService,
  ) {}

  async generateInvoicesForDueSubscriptions(
    scheduledDate: string,
    correlationId: string,
  ): Promise<GenerationResult> {
    const dueSubscriptions =
      await this.subscriptionsRepository.findDueForBilling(
        new Date(scheduledDate),
      );

    this.logger.log({
      message: "Found due subscriptions for invoice generation",
      count: dueSubscriptions.length,
      scheduledDate,
      correlationId,
    });

    let created = 0;
    let skipped = 0;
    let failed = 0;
    let finalized = 0;

    for (const subscription of dueSubscriptions) {
      try {
        const existingInvoice =
          await this.invoicesRepository.findDuplicateForSubscription(
            subscription.id,
            subscription.billingPeriodStart,
            subscription.billingPeriodEnd,
          );

        if (existingInvoice.length > 0) {
          skipped++;
          this.logger.log({
            message: "Skipping already-invoiced subscription",
            subscriptionId: subscription.id,
            correlationId,
          });
          continue;
        }

        const { invoice, creditResult } =
          await this.createInvoiceForSubscription(subscription, correlationId);

        const invDualWriteMetadata =
          await this.dualWriteService?.getDualWriteMetadata(invoice.customerId);

        if (creditResult.newTotal === 0) {
          try {
            await this.sqsProducerService.publish(
              "invoice.paid",
              {
                invoiceId: invoice.id,
                customerId: invoice.customerId,
                totalAmountCents: 0,
                currency: invoice.currency,
                paidAt: new Date().toISOString(),
              },
              correlationId,
              invDualWriteMetadata,
            );
          } catch (publishError) {
            if (invDualWriteMetadata) {
              await this.dualWriteService?.logDualWriteFailure(
                invoice.customerId,
                "invoice.paid",
                { invoiceId: invoice.id },
                publishError,
                correlationId,
              );
            } else {
              throw publishError;
            }
          }
        } else {
          try {
            await this.sqsProducerService.publish(
              "invoice.created",
              {
                invoiceId: invoice.id,
                customerId: invoice.customerId,
                subscriptionId: invoice.subscriptionId ?? undefined,
                totalAmountCents: creditResult.newTotal,
                currency: invoice.currency,
                billingPeriodStart: invoice.billingPeriodStart.toISOString(),
                billingPeriodEnd: invoice.billingPeriodEnd.toISOString(),
              },
              correlationId,
              invDualWriteMetadata,
            );
          } catch (publishError) {
            if (invDualWriteMetadata) {
              await this.dualWriteService?.logDualWriteFailure(
                invoice.customerId,
                "invoice.created",
                { invoiceId: invoice.id },
                publishError,
                correlationId,
              );
            } else {
              throw publishError;
            }
          }

          try {
            if (this.chargesService) {
              await this.chargesService.executePaymentForInvoice(
                invoice.id,
                correlationId,
              );
            }
          } catch (paymentError) {
            this.logger.warn({
              message: "Payment execution failed for invoice",
              invoiceId: invoice.id,
              subscriptionId: subscription.id,
              error:
                paymentError instanceof Error
                  ? paymentError.message
                  : String(paymentError),
              correlationId,
            });
          }
        }

        created++;
      } catch (error) {
        failed++;
        this.logger.error({
          message: "Failed to generate invoice for subscription",
          subscriptionId: subscription.id,
          error: error instanceof Error ? error.message : String(error),
          correlationId,
        });
      }
    }

    const pendingOnboarding =
      await this.invoicesRepository.findPendingOnboarding(
        new Date(scheduledDate),
      );

    this.logger.log({
      message: "Found pending onboarding invoices for finalization",
      count: pendingOnboarding.length,
      scheduledDate,
      correlationId,
    });

    for (const onboardingInvoice of pendingOnboarding) {
      try {
        let onboardingCreditResult: CreditApplicationResult = {
          creditApplied: 0,
          newTotal: onboardingInvoice.totalAmountCents,
        };

        await this.db.transaction(async (tx) => {
          validateTransition(
            onboardingInvoice.status as InvoiceStatus,
            "finalized" as InvoiceStatus,
            INVOICE_TRANSITIONS,
          );

          await this.invoicesRepository.update(
            onboardingInvoice.id,
            { status: "finalized", updatedAt: new Date() },
            tx,
          );

          await this.ledgerService.recordInvoiceFinalized(
            onboardingInvoice.id,
            onboardingInvoice.totalAmountCents,
            onboardingInvoice.currency,
            correlationId,
            tx,
          );

          if (this.creditsService) {
            onboardingCreditResult =
              await this.creditsService.applyCreditsToInvoice(
                onboardingInvoice.id,
                onboardingInvoice.customerId,
                onboardingInvoice.totalAmountCents,
                onboardingInvoice.currency,
                correlationId,
                tx,
              );

            if (onboardingCreditResult.newTotal === 0) {
              validateTransition(
                "finalized" as InvoiceStatus,
                "paid" as InvoiceStatus,
                INVOICE_TRANSITIONS,
              );

              await this.invoicesRepository.update(
                onboardingInvoice.id,
                { status: "paid", paidAt: new Date(), updatedAt: new Date() },
                tx,
              );
            }
          }
        });

        this.logger.log({
          message: "Onboarding invoice finalized",
          invoiceId: onboardingInvoice.id,
          customerId: onboardingInvoice.customerId,
          totalAmountCents: onboardingInvoice.totalAmountCents,
          creditApplied: onboardingCreditResult.creditApplied,
          finalTotal: onboardingCreditResult.newTotal,
          correlationId,
        });

        const obDualWriteMetadata =
          await this.dualWriteService?.getDualWriteMetadata(
            onboardingInvoice.customerId,
          );

        if (onboardingCreditResult.newTotal === 0) {
          try {
            await this.sqsProducerService.publish(
              "invoice.paid",
              {
                invoiceId: onboardingInvoice.id,
                customerId: onboardingInvoice.customerId,
                totalAmountCents: 0,
                currency: onboardingInvoice.currency,
                paidAt: new Date().toISOString(),
              },
              correlationId,
              obDualWriteMetadata,
            );
          } catch (publishError) {
            if (obDualWriteMetadata) {
              await this.dualWriteService?.logDualWriteFailure(
                onboardingInvoice.customerId,
                "invoice.paid",
                { invoiceId: onboardingInvoice.id },
                publishError,
                correlationId,
              );
            } else {
              throw publishError;
            }
          }
        } else {
          try {
            if (this.chargesService) {
              await this.chargesService.executePaymentForInvoice(
                onboardingInvoice.id,
                correlationId,
              );
            }
          } catch (paymentError) {
            this.logger.warn({
              message: "Payment execution failed for onboarding invoice",
              invoiceId: onboardingInvoice.id,
              error:
                paymentError instanceof Error
                  ? paymentError.message
                  : String(paymentError),
              correlationId,
            });
          }
        }

        finalized++;
      } catch (error) {
        failed++;
        this.logger.error({
          message: "Failed to finalize onboarding invoice",
          invoiceId: onboardingInvoice.id,
          error: error instanceof Error ? error.message : String(error),
          correlationId,
        });
      }
    }

    this.logger.log({
      message: "Invoice generation completed",
      created,
      skipped,
      failed,
      finalized,
      correlationId,
    });

    return { created, skipped, finalized };
  }

  async findById(id: string): Promise<InvoiceResponseDto | null> {
    const result = await this.invoicesRepository.findByIdWithLineItems(id);
    if (!result) return null;
    return this.toResponseDto(result.invoice, result.lineItems);
  }

  async findAll(
    query: InvoiceQueryDto,
  ): Promise<PaginatedResult<InvoiceResponseDto>> {
    const limit = query.limit ?? 20;

    const results = await this.invoicesRepository.findAll(
      {
        customerId: query.customerId,
        status: query.status,
        startDate: query.startDate,
        endDate: query.endDate,
        cursor: query.cursor,
      },
      limit,
    );

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const lastItem = data[data.length - 1];

    const invoiceIds = data.map((inv) => inv.id);
    const allLineItems =
      await this.invoicesRepository.getLineItemsByInvoiceIds(invoiceIds);

    const lineItemsByInvoiceId = new Map<
      string,
      Array<typeof invoiceLineItems.$inferSelect>
    >();
    for (const item of allLineItems) {
      const existing = lineItemsByInvoiceId.get(item.invoiceId) ?? [];
      existing.push(item);
      lineItemsByInvoiceId.set(item.invoiceId, existing);
    }

    const invoicesWithLineItems = data.map((invoice) =>
      this.toResponseDto(invoice, lineItemsByInvoiceId.get(invoice.id) ?? []),
    );

    return {
      data: invoicesWithLineItems,
      cursor: hasMore && lastItem ? lastItem.id : null,
      hasMore,
    };
  }

  async voidInvoice(
    id: string,
    correlationId?: string,
  ): Promise<InvoiceResponseDto> {
    const invoice = await this.invoicesRepository.findById(id);

    if (!invoice) {
      throw new InvoiceNotFoundException(id);
    }

    switch (invoice.status) {
      case "paid":
        throw new InvoiceAlreadyPaidException(id);
      case "draft":
        throw new InvoiceNotFinalizedException(id);
      case "void":
        throw new InvoiceAlreadyVoidedException(id);
      case "finalized":
        break;
      default:
        validateTransition(
          invoice.status as InvoiceStatus,
          "void" as InvoiceStatus,
          INVOICE_TRANSITIONS,
        );
    }

    const now = new Date();

    const updated = await this.db.transaction(async (tx) => {
      const row = await this.invoicesRepository.updateWithConcurrencyCheck(
        id,
        { status: "void", voidedAt: now, updatedAt: now },
        "finalized",
        tx,
      );

      if (!row) {
        throw new StateTransitionException(
          `Invoice ${id} was modified concurrently`,
          { errorCode: "CONCURRENT_MODIFICATION" },
        );
      }

      await this.ledgerService.recordInvoiceVoided(
        id,
        invoice.totalAmountCents,
        invoice.currency,
        correlationId ?? id,
        tx,
      );

      return row;
    });

    this.logger.log({
      message: "Invoice voided",
      invoiceId: id,
      customerId: invoice.customerId,
      totalAmountCents: invoice.totalAmountCents,
      correlationId,
    });

    const items = await this.invoicesRepository.getLineItemsByInvoiceId(id);

    return this.toResponseDto(updated, items);
  }

  private async createInvoiceForSubscription(
    subscription: typeof subscriptions.$inferSelect,
    correlationId: string,
  ): Promise<{
    invoice: typeof invoices.$inferSelect;
    creditResult: CreditApplicationResult;
  }> {
    const lineItemsData = this.calculateLineItems(subscription);
    const totalAmountCents = lineItemsData.reduce(
      (sum, item) => sum + item.amountCents * item.quantity,
      0,
    );

    const invoiceId = generateId();
    const dueDate = new Date(subscription.billingPeriodEnd);
    const now = new Date();

    let creditResult: CreditApplicationResult = {
      creditApplied: 0,
      newTotal: totalAmountCents,
    };

    const result = await this.db.transaction(async (tx) => {
      const created = await this.invoicesRepository.create(
        {
          id: invoiceId,
          customerId: subscription.customerId,
          subscriptionId: subscription.id,
          status: "draft",
          totalAmountCents: 0,
          currency: subscription.currency,
          billingPeriodStart: subscription.billingPeriodStart,
          billingPeriodEnd: subscription.billingPeriodEnd,
          dueDate,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        },
        tx,
      );

      for (const item of lineItemsData) {
        await this.invoicesRepository.createLineItem(
          {
            id: generateId(),
            invoiceId,
            type: item.type,
            description: item.description,
            amountCents: item.amountCents,
            quantity: item.quantity,
            createdAt: now,
          },
          tx,
        );
      }

      validateTransition(
        "draft" as InvoiceStatus,
        "finalized" as InvoiceStatus,
        INVOICE_TRANSITIONS,
      );

      const finalized = await this.invoicesRepository.update(
        invoiceId,
        { totalAmountCents, status: "finalized", updatedAt: now },
        tx,
      );

      await this.ledgerService.recordInvoiceFinalized(
        invoiceId,
        totalAmountCents,
        subscription.currency,
        correlationId,
        tx,
      );

      if (this.creditsService) {
        creditResult = await this.creditsService.applyCreditsToInvoice(
          invoiceId,
          subscription.customerId,
          totalAmountCents,
          subscription.currency,
          correlationId,
          tx,
        );

        if (creditResult.newTotal === 0) {
          validateTransition(
            "finalized" as InvoiceStatus,
            "paid" as InvoiceStatus,
            INVOICE_TRANSITIONS,
          );

          await this.invoicesRepository.update(
            invoiceId,
            { status: "paid", paidAt: new Date(), updatedAt: new Date() },
            tx,
          );
        }
      }

      return finalized ?? created;
    });

    this.logger.log({
      message: "Invoice created and finalized",
      invoiceId,
      subscriptionId: subscription.id,
      customerId: subscription.customerId,
      totalAmountCents,
      creditApplied: creditResult.creditApplied,
      finalTotal: creditResult.newTotal,
      correlationId,
    });

    const adjustedInvoice =
      creditResult.creditApplied > 0
        ? {
            ...result,
            totalAmountCents: creditResult.newTotal,
            ...(creditResult.newTotal === 0
              ? { status: "paid" as const, paidAt: new Date() }
              : {}),
          }
        : result;

    return { invoice: adjustedInvoice, creditResult };
  }

  private calculateLineItems(
    subscription: typeof subscriptions.$inferSelect,
  ): Array<{
    type: string;
    description: string;
    amountCents: number;
    quantity: number;
  }> {
    const lineItems = [];

    lineItems.push({
      type: "base_fee",
      description: `${subscription.planName} - ${subscription.billingInterval} subscription`,
      amountCents: subscription.amountCents,
      quantity: 1,
    });

    return lineItems;
  }

  private toResponseDto(
    invoice: typeof invoices.$inferSelect,
    items: Array<typeof invoiceLineItems.$inferSelect>,
  ): InvoiceResponseDto {
    return {
      id: invoice.id,
      customerId: invoice.customerId,
      subscriptionId: invoice.subscriptionId,
      status: invoice.status,
      totalAmountCents: invoice.totalAmountCents,
      currency: invoice.currency,
      billingPeriodStart: invoice.billingPeriodStart.toISOString(),
      billingPeriodEnd: invoice.billingPeriodEnd.toISOString(),
      dueDate: invoice.dueDate.toISOString(),
      paidAt: invoice.paidAt?.toISOString() ?? null,
      voidedAt: invoice.voidedAt?.toISOString() ?? null,
      metadata: invoice.metadata as Record<string, unknown> | null,
      lineItems: items.map((item) => this.toLineItemResponseDto(item)),
      createdAt: invoice.createdAt.toISOString(),
      updatedAt: invoice.updatedAt.toISOString(),
    };
  }

  private toLineItemResponseDto(
    item: typeof invoiceLineItems.$inferSelect,
  ): InvoiceLineItemResponseDto {
    return {
      id: item.id,
      invoiceId: item.invoiceId,
      type: item.type,
      description: item.description,
      amountCents: item.amountCents,
      quantity: item.quantity,
      createdAt: item.createdAt.toISOString(),
    };
  }
}
