import { Inject, Injectable, Logger, Optional, forwardRef } from "@nestjs/common";
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
import type {
  InvoiceCreatePayload,
  PayrollEmployeeLineItem,
} from "../integration/sqs/contracts/inbound-events";
import { CustomersService } from "../customers/customers.service";
import { SurchargeConfigService } from "../surcharges/surcharge-config.service";
import { PaymentMethodsService } from "../payment-methods/payment-methods.service";
import { PAYMENT_METHOD_TYPE_CARD } from "../common/constants/payment-method-types";
import { calculateInvoiceDueDate } from "../common/utils/billing-date.util";

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
    @Inject(forwardRef(() => CustomersService))
    private readonly customersService: CustomersService,
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
    @Optional()
    private readonly surchargeConfigService?: SurchargeConfigService,
    @Optional()
    @Inject(forwardRef(() => PaymentMethodsService))
    private readonly paymentMethodsService?: PaymentMethodsService,
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

        const invCustomer = await this.customersService.findById(invoice.customerId);
        const invMonolithCustomerId = invCustomer?.monolithCustomerId ?? "";

        const invDualWriteMetadata =
          await this.dualWriteService?.getDualWriteMetadata(invoice.customerId);

        if (creditResult.newTotal === 0) {
          try {
            await this.sqsProducerService.publish(
              "invoice.paid",
              {
                invoiceId: invoice.id,
                customerId: invoice.customerId,
                monolithCustomerId: invMonolithCustomerId,
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
                monolithCustomerId: invMonolithCustomerId,
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

        const obCustomer = await this.customersService.findById(onboardingInvoice.customerId);
        const obMonolithCustomerId = obCustomer?.monolithCustomerId ?? "";

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
                monolithCustomerId: obMonolithCustomerId,
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
        type: query.type,
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

  /**
   * Void any draft invoices for a customer. Called when a subscription is paused/cancelled.
   * Finalized invoices are intentionally left alone — they represent real debt (payment
   * may be in-flight, e.g. ACH; dunning may still recover failed charges). Parity with
   * monolith, which never cancels outstanding invoices on churn.
   */
  async voidDraftInvoicesForCustomer(
    customerId: string,
    correlationId?: string,
  ): Promise<number> {
    const draftInvoice = await this.invoicesRepository.findDraftByCustomerId(customerId);
    if (!draftInvoice) return 0;

    const now = new Date();
    await this.invoicesRepository.update(draftInvoice.id, {
      status: "void",
      voidedAt: now,
      updatedAt: now,
    });

    this.logger.log({
      message: "Draft invoice voided on subscription pause/cancel",
      invoiceId: draftInvoice.id,
      customerId,
      correlationId,
    });

    return 1;
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
    let totalAmountCents = lineItemsData.reduce(
      (sum, item) => sum + item.amountCents * item.quantity,
      0,
    );

    const surcharge = await this.calculateSurcharge(
      subscription.customerId,
      totalAmountCents,
    );
    if (surcharge) {
      lineItemsData.push({
        type: "surcharge",
        description: surcharge.description,
        amountCents: surcharge.amountCents,
        quantity: 1,
      });
      totalAmountCents += surcharge.amountCents;
    }

    const invoiceId = generateId();
    const now = new Date();

    // Compute due date from customer's chargeDay / isPrepaid
    const customer = await this.customersService.findById(subscription.customerId);
    const chargeDay = customer?.chargeDay ?? 15;
    const isPrepaid = customer?.isPrepaid ?? true;
    const dueDate = calculateInvoiceDueDate(subscription.billingPeriodStart, chargeDay, isPrepaid);

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
          type: "recurring",
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

  /**
   * Creates a standalone invoice from an inbound event (onboarding, one_time).
   * Not linked to a subscription — independent one-time charge.
   * If dueDate <= now, finalizes and charges immediately.
   */
  async createFromEvent(
    payload: InvoiceCreatePayload,
    billingCustomerId: string,
    correlationId: string,
  ): Promise<string> {
    const now = new Date();
    const dueDate = new Date(payload.dueDate);

    // Extract per-item breakdowns from metadata (one-time charges send full item data)
    const itemBreakdowns = (payload.metadata as any)?.items as any[] | undefined;

    const lineItems = payload.lineItems.map((item, index) => ({
      type: payload.type,
      description: item.description,
      amountCents: item.amountCents,
      quantity: 1,
      breakdown: itemBreakdowns?.[index] ?? null,
    }));

    const invoiceId = await this.createDraftInvoice(
      {
        customerId: billingCustomerId,
        subscriptionId: null,
        type: payload.type,
        lineItems,
        totalAmountCents: payload.totalAmountCents,
        currency: payload.currency ?? "usd",
        billingPeriodStart: now,
        billingPeriodEnd: now,
        dueDate,
        metadata: null,
      },
      correlationId,
    );

    this.logger.log({
      message: "Standalone invoice created from event",
      invoiceId,
      customerId: billingCustomerId,
      type: payload.type,
      totalAmountCents: payload.totalAmountCents,
      chargeImmediately: dueDate <= now,
      correlationId,
    });

    if (dueDate <= now) {
      await this.finalizeAndCharge(invoiceId, correlationId);
    }

    return invoiceId;
  }

  /**
   * Creates a draft invoice with line items. Used by SubscriptionsService for
   * first monthly invoices, and by createFromEvent for standalone invoices.
   */
  async createDraftInvoice(
    params: {
      customerId: string;
      subscriptionId: string | null;
      type: "onboarding" | "one_time" | "recurring";
      lineItems: Array<{
        type: string;
        description: string;
        amountCents: number;
        quantity: number;
        breakdown?: Record<string, number | string> | null;
      }>;
      totalAmountCents: number;
      currency: string;
      billingPeriodStart: Date;
      billingPeriodEnd: Date;
      dueDate: Date;
      metadata?: Record<string, unknown> | null;
    },
    correlationId: string,
  ): Promise<string> {
    const invoiceId = generateId();
    const now = new Date();

    // Calculate surcharge on raw subtotal before persisting
    const allLineItems = [...params.lineItems];
    let adjustedTotal = params.totalAmountCents;

    const surcharge = await this.calculateSurcharge(
      params.customerId,
      params.totalAmountCents,
    );
    if (surcharge) {
      allLineItems.push({
        type: "surcharge",
        description: surcharge.description,
        amountCents: surcharge.amountCents,
        quantity: 1,
      });
      adjustedTotal += surcharge.amountCents;
    }

    await this.db.transaction(async (tx) => {
      await this.invoicesRepository.create(
        {
          id: invoiceId,
          customerId: params.customerId,
          subscriptionId: params.subscriptionId,
          type: params.type,
          status: "draft",
          totalAmountCents: adjustedTotal,
          currency: params.currency,
          billingPeriodStart: params.billingPeriodStart,
          billingPeriodEnd: params.billingPeriodEnd,
          dueDate: params.dueDate,
          metadata: params.metadata ?? null,
          createdAt: now,
          updatedAt: now,
        },
        tx,
      );

      if (allLineItems.length > 0) {
        const lineItemRows = allLineItems.map((item) => ({
          id: generateId(),
          invoiceId,
          type: item.type,
          description: item.description,
          amountCents: item.amountCents,
          quantity: item.quantity,
          breakdown: item.breakdown ?? null,
          createdAt: now,
        }));

        await this.invoicesRepository.createLineItems(lineItemRows, tx);
      }
    });

    this.logger.log({
      message: "Draft invoice created",
      invoiceId,
      customerId: params.customerId,
      subscriptionId: params.subscriptionId,
      totalAmountCents: params.totalAmountCents,
      lineItemCount: params.lineItems.length,
      correlationId,
    });

    return invoiceId;
  }

  /**
   * Finalizes a draft invoice (applies credits) and attempts payment.
   * Used for onboarding invoices that are due immediately.
   */
  async finalizeAndCharge(
    invoiceId: string,
    correlationId: string,
  ): Promise<void> {
    const result = await this.invoicesRepository.findByIdWithLineItems(invoiceId);
    if (!result) {
      throw new InvoiceNotFoundException(invoiceId);
    }

    const { invoice } = result;

    let creditResult: CreditApplicationResult = {
      creditApplied: 0,
      newTotal: invoice.totalAmountCents,
    };

    await this.db.transaction(async (tx) => {
      validateTransition(
        invoice.status as InvoiceStatus,
        "finalized" as InvoiceStatus,
        INVOICE_TRANSITIONS,
      );

      await this.invoicesRepository.update(
        invoiceId,
        { status: "finalized", updatedAt: new Date() },
        tx,
      );

      await this.ledgerService.recordInvoiceFinalized(
        invoiceId,
        invoice.totalAmountCents,
        invoice.currency,
        correlationId,
        tx,
      );

      if (this.creditsService) {
        creditResult = await this.creditsService.applyCreditsToInvoice(
          invoiceId,
          invoice.customerId,
          invoice.totalAmountCents,
          invoice.currency,
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
    });

    this.logger.log({
      message: "Invoice finalized",
      invoiceId,
      totalAmountCents: invoice.totalAmountCents,
      creditApplied: creditResult.creditApplied,
      finalTotal: creditResult.newTotal,
      correlationId,
    });

    if (creditResult.newTotal > 0 && this.chargesService) {
      try {
        await this.chargesService.executePaymentForInvoice(
          invoiceId,
          correlationId,
        );
      } catch (paymentError) {
        this.logger.warn({
          message: "Payment execution failed after finalization",
          invoiceId,
          error:
            paymentError instanceof Error
              ? paymentError.message
              : String(paymentError),
          correlationId,
        });
      }
    }
  }

  async findOpenByCustomerId(customerId: string) {
    return this.invoicesRepository.findOpenByCustomerId(customerId);
  }

  async updateOpenInvoiceLineItems(
    customerId: string,
    employees: PayrollEmployeeLineItem[],
    totalAmountCents: number,
    correlationId: string,
  ): Promise<void> {
    // Find the open (draft or finalized) invoice for this customer
    const openInvoice = await this.invoicesRepository.findOpenByCustomerId(
      customerId,
    );

    if (!openInvoice) {
      this.logger.warn({
        message: "No open invoice found for line item update",
        customerId,
        correlationId,
      });
      return;
    }

    const now = new Date();

    // Build one line item per employee with breakdown in JSONB
    const newLineItems = employees.map((emp) => ({
      id: generateId(),
      invoiceId: openInvoice.id,
      type: "employee_cost",
      description: emp.employeeName,
      amountCents: emp.customerCost,
      quantity: 1,
      breakdown: {
        employeeId: emp.employeeId,
        salary: emp.salary,
        platformFee: emp.platformFee,
        bonus: emp.bonus,
        raise: emp.raise,
        discount: emp.discount,
      },
      createdAt: now,
    }));

    // Calculate surcharge on the employee subtotal
    let adjustedTotal = totalAmountCents;
    const surcharge = await this.calculateSurcharge(customerId, totalAmountCents);
    if (surcharge) {
      newLineItems.push({
        id: generateId(),
        invoiceId: openInvoice.id,
        type: "surcharge",
        description: surcharge.description,
        amountCents: surcharge.amountCents,
        quantity: 1,
        breakdown: null as any,
        createdAt: now,
      });
      adjustedTotal += surcharge.amountCents;
    }

    await this.db.transaction(async (tx) => {
      await this.invoicesRepository.deleteLineItemsByInvoiceId(
        openInvoice.id,
        tx,
      );

      await this.invoicesRepository.createLineItems(newLineItems, tx);

      await this.invoicesRepository.update(
        openInvoice.id,
        { totalAmountCents: adjustedTotal, updatedAt: now },
        tx,
      );
    });

    this.logger.log({
      message: "Open invoice line items updated",
      invoiceId: openInvoice.id,
      customerId,
      employeeCount: employees.length,
      totalAmountCents: adjustedTotal,
      surchargeAmountCents: surcharge?.amountCents ?? 0,
      correlationId,
    });
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
      type: invoice.type,
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
      breakdown: item.breakdown as Record<string, number> | null,
      createdAt: item.createdAt.toISOString(),
    };
  }

  private async calculateSurcharge(
    customerId: string,
    subtotalCents: number,
  ): Promise<{ amountCents: number; description: string } | null> {
    if (!this.paymentMethodsService || !this.surchargeConfigService) return null;

    const defaultPm =
      await this.paymentMethodsService.getDefaultPaymentMethod(customerId);
    if (!defaultPm || defaultPm.type !== PAYMENT_METHOD_TYPE_CARD) return null;

    const config = await this.surchargeConfigService.getConfig(customerId);
    if (!config || !config.surchargeType || !config.surchargeValue) return null;

    let amountCents: number;
    if (config.surchargeType === "percentage") {
      amountCents = Math.round(
        (subtotalCents * config.surchargeValue) / 100,
      );
    } else {
      // flat_fee: surchargeValue is in dollars, convert to cents
      amountCents = config.surchargeValue * 100;
    }

    if (amountCents <= 0) return null;

    return { amountCents, description: "Credit card surcharge" };
  }

  async recalculateSurchargeOnOpenInvoice(
    customerId: string,
    correlationId: string,
  ): Promise<void> {
    const openInvoice =
      await this.invoicesRepository.findOpenByCustomerId(customerId);
    if (!openInvoice) return;

    const items = await this.invoicesRepository.getLineItemsByInvoiceId(
      openInvoice.id,
    );
    const nonSurchargeItems = items.filter((i) => i.type !== "surcharge");
    const subtotalCents = nonSurchargeItems.reduce(
      (sum, i) => sum + i.amountCents * i.quantity,
      0,
    );

    const surcharge = await this.calculateSurcharge(customerId, subtotalCents);
    const newTotal = subtotalCents + (surcharge?.amountCents ?? 0);

    await this.db.transaction(async (tx) => {
      await this.invoicesRepository.deleteLineItemsByInvoiceIdAndType(
        openInvoice.id,
        "surcharge",
        tx,
      );

      if (surcharge) {
        await this.invoicesRepository.createLineItem(
          {
            id: generateId(),
            invoiceId: openInvoice.id,
            type: "surcharge",
            description: surcharge.description,
            amountCents: surcharge.amountCents,
            quantity: 1,
            createdAt: new Date(),
          },
          tx,
        );
      }

      await this.invoicesRepository.update(
        openInvoice.id,
        { totalAmountCents: newTotal, updatedAt: new Date() },
        tx,
      );
    });

    this.logger.log({
      message: "Surcharge recalculated on open invoice",
      invoiceId: openInvoice.id,
      customerId,
      subtotalCents,
      surchargeAmountCents: surcharge?.amountCents ?? 0,
      newTotal,
      correlationId,
    });
  }
}
