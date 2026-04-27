import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { GatewayRegistry } from "../gateway/gateway.registry";
import { GatewayProvider } from "../common/enums/gateway-provider.enum";
import { LedgerService } from "../ledger/ledger.service";
import { SqsProducerService } from "../integration/sqs/sqs-producer.service";
import { PaymentMethodsService } from "../payment-methods/payment-methods.service";
import { PaymentMethodsRepository } from "../payment-methods/payment-methods.repository";
import { CustomersService } from "../customers/customers.service";
import { generateId } from "../common/utils/uuid.util";
import { validateTransition } from "../common/utils/state-machine.util";
import {
  INVOICE_TRANSITIONS,
  type InvoiceStatus,
} from "../invoices/invoice-state-machine";
import { DunningService } from "../dunning/dunning.service";
import { NoPaymentMethodException } from "../common/exceptions/no-payment-method.exception";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import { BusinessRuleViolationException } from "../common/exceptions/billing.exception";
import { InvoiceAlreadyPaidException } from "./invoice-already-paid.exception";
import { InvoiceNotFinalizedException } from "./invoice-not-finalized.exception";
import type { CreateOneTimeChargeDto } from "./dto/create-one-time-charge.dto";
import { DualWriteService } from "../migration/dual-write.service";
import type { CreateOnboardingChargeDto } from "./dto/create-onboarding-charge.dto";
import type { OneTimeChargeResponseDto } from "./dto/one-time-charge-response.dto";
import type { OnboardingChargeResponseDto } from "./dto/onboarding-charge-response.dto";
import type { ChargeResultDto } from "./dto/charge-result.dto";
import type { ChargeResponseDto } from "./dto/charge-response.dto";
import type { InvoiceResponseDto } from "../invoices/dto/invoice-response.dto";
import type { InvoiceLineItemResponseDto } from "../invoices/dto/invoice-line-item-response.dto";
import { ChargesRepository } from "./charges.repository";
import { InvoicesRepository } from "../invoices/invoices.repository";

export const SUBSCRIPTIONS_SERVICE = Symbol("SUBSCRIPTIONS_SERVICE");
@Injectable()
export class ChargesService {
  private readonly logger = new Logger(ChargesService.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    private readonly chargesRepository: ChargesRepository,
    private readonly invoicesRepository: InvoicesRepository,
    private readonly paymentMethodsRepository: PaymentMethodsRepository,
    private readonly gatewayRegistry: GatewayRegistry,
    private readonly ledgerService: LedgerService,
    private readonly sqsProducerService: SqsProducerService,
    private readonly paymentMethodsService: PaymentMethodsService,
    private readonly customersService: CustomersService,
    @Optional()
    @Inject(SUBSCRIPTIONS_SERVICE)
    private readonly subscriptionsService?: {
      advanceBillingPeriod: (
        subscriptionId: string,
        correlationId?: string,
      ) => Promise<unknown>;
    },
    @Optional()
    private readonly dunningService?: DunningService,
    @Optional()
    private readonly dualWriteService?: DualWriteService,
  ) {}

  async executePaymentForInvoice(
    invoiceId: string,
    correlationId: string,
    attemptNumber = 1,
    paymentMethodId?: string,
  ): Promise<ChargeResultDto> {
    // 1. Load invoice and verify status
    const invoice = await this.invoicesRepository.findById(invoiceId);

    if (!invoice) {
      throw new BusinessRuleViolationException(
        `Invoice not found: ${invoiceId}`,
      );
    }

    if (invoice.status === "paid") {
      throw new InvoiceAlreadyPaidException(invoiceId);
    }

    if (invoice.status !== "finalized") {
      throw new InvoiceNotFinalizedException(invoiceId, invoice.status);
    }

    // 2. Load payment method — specific PM if provided, otherwise default
    const pm = paymentMethodId
      ? await this.paymentMethodsService.getActivePaymentMethodById(
          invoice.customerId,
          paymentMethodId,
        )
      : await this.paymentMethodsService.getDefaultPaymentMethod(
          invoice.customerId,
        );

    if (!pm) {
      throw new NoPaymentMethodException(invoice.customerId);
    }

    // 3. Load customer and resolve gateway-specific customer ID
    const customer = await this.customersService.findById(invoice.customerId);
    if (!customer) {
      throw new CustomerNotFoundException(invoice.customerId);
    }

    const pmGatewayProvider = pm.gatewayProvider as GatewayProvider;
    const gatewayCustomerId =
      await this.paymentMethodsService.resolveGatewayCustomerId(
        invoice.customerId,
        pmGatewayProvider,
        customer,
      );

    // 4. Generate idempotency key
    const idempotencyKey = `inv_${invoiceId}_att_${attemptNumber}`;

    // 5. Insert charge record (pending) — catch unique constraint for idempotency
    const chargeId = generateId();
    const now = new Date();

    const { charge: createdCharge, isDuplicate } =
      await this.chargesRepository.createWithIdempotency({
        id: chargeId,
        invoiceId,
        customerId: invoice.customerId,
        paymentMethodId: pm.id,
        amountCents: invoice.totalAmountCents,
        currency: invoice.currency,
        status: "pending",
        idempotencyKey,
        attemptNumber,
        createdAt: now,
        updatedAt: now,
      });

    if (isDuplicate) {
      this.logger.log({
        message: "Duplicate charge detected via idempotency key",
        idempotencyKey,
        invoiceId,
        correlationId,
      });

      return {
        chargeId: createdCharge.id,
        status: createdCharge.status as "pending" | "succeeded" | "failed",
        stripePaymentIntentId: createdCharge.stripePaymentIntentId,
      };
    }

    // 6. Call gateway — Stripe-before-DB ordering
    try {
      const gateway = this.gatewayRegistry.getAdapter(pmGatewayProvider);
      const gatewayResult = await gateway.createCharge({
        amount: invoice.totalAmountCents,
        currency: invoice.currency,
        customerId: gatewayCustomerId,
        paymentMethodId: pm.stripePaymentMethodId,
        idempotencyKey,
        description: `Invoice ${invoiceId}`,
        metadata: {
          billingCustomerId: invoice.customerId,
          billingInvoiceId: invoiceId,
          monolithCustomerId: customer.monolithCustomerId ?? "",
        },
      });

      // 7a. Branch on gateway result status
      if (gatewayResult.status === "succeeded") {
        // Synchronous success (cards): update charge, invoice, ledger in one transaction
        await this.db.transaction(async (tx) => {
          await this.chargesRepository.updateStatus(
            chargeId,
            {
              status: "succeeded",
              stripePaymentIntentId: gatewayResult.id,
              updatedAt: new Date(),
            },
            tx,
          );

          validateTransition(
            invoice.status as InvoiceStatus,
            "paid" as InvoiceStatus,
            INVOICE_TRANSITIONS,
          );

          await this.invoicesRepository.update(
            invoiceId,
            {
              status: "paid",
              paidAt: new Date(),
              updatedAt: new Date(),
            },
            tx,
          );

          await this.ledgerService.recordPaymentSucceeded(
            chargeId,
            invoice.totalAmountCents,
            invoice.currency,
            correlationId,
            tx,
          );
        });

        this.logger.log({
          message: "Payment succeeded (synchronous)",
          chargeId,
          invoiceId,
          stripePaymentIntentId: gatewayResult.id,
          amountCents: invoice.totalAmountCents,
          correlationId,
        });

        // Publish events (outside transaction)
        const dualWriteMetadata =
          await this.dualWriteService?.getDualWriteMetadata(invoice.customerId);

        try {
          await this.sqsProducerService.publish(
            "payment.succeeded",
            {
              invoiceId,
              customerId: invoice.customerId,
              monolithCustomerId: customer.monolithCustomerId,
              amountCents: invoice.totalAmountCents,
              currency: invoice.currency,
              paymentMethodId: pm.id,
              stripePaymentIntentId: gatewayResult.id,
            },
            correlationId,
            dualWriteMetadata,
          );
        } catch (publishError) {
          if (dualWriteMetadata) {
            await this.dualWriteService?.logDualWriteFailure(
              invoice.customerId,
              "payment.succeeded",
              { invoiceId, amountCents: invoice.totalAmountCents },
              publishError,
              correlationId,
            );
          } else {
            throw publishError;
          }
        }

        try {
          await this.sqsProducerService.publish(
            "invoice.paid",
            {
              invoiceId,
              customerId: invoice.customerId,
              monolithCustomerId: customer.monolithCustomerId,
              totalAmountCents: invoice.totalAmountCents,
              currency: invoice.currency,
              paidAt: new Date().toISOString(),
            },
            correlationId,
            dualWriteMetadata,
          );
        } catch (publishError) {
          if (dualWriteMetadata) {
            await this.dualWriteService?.logDualWriteFailure(
              invoice.customerId,
              "invoice.paid",
              { invoiceId, totalAmountCents: invoice.totalAmountCents },
              publishError,
              correlationId,
            );
          } else {
            throw publishError;
          }
        }

        return {
          chargeId,
          status: "succeeded" as const,
          stripePaymentIntentId: gatewayResult.id,
        };
      } else if (gatewayResult.status === "pending") {
        // Async payment (ACH): record PI ID, leave invoice as finalized — webhook will complete
        await this.chargesRepository.updateStatus(chargeId, {
          stripePaymentIntentId: gatewayResult.id,
          updatedAt: new Date(),
        });

        this.logger.log({
          message: "Payment pending (async) — waiting for webhook",
          chargeId,
          invoiceId,
          stripePaymentIntentId: gatewayResult.id,
          amountCents: invoice.totalAmountCents,
          correlationId,
        });

        return {
          chargeId,
          status: "pending" as const,
          stripePaymentIntentId: gatewayResult.id,
        };
      } else {
        // Gateway returned failed status
        await this.chargesRepository.updateStatus(chargeId, {
          status: "failed",
          stripePaymentIntentId: gatewayResult.id,
          failureReason:
            gatewayResult.failureMessage || "Payment declined by gateway",
          updatedAt: new Date(),
        });

        this.logger.warn({
          message: "Payment failed (gateway declined)",
          chargeId,
          invoiceId,
          stripePaymentIntentId: gatewayResult.id,
          failureReason: gatewayResult.failureMessage,
          correlationId,
        });

        return {
          chargeId,
          status: "failed" as const,
          stripePaymentIntentId: gatewayResult.id,
        };
      }
    } catch (error) {
      // 7b. FAILURE: update charge to failed, publish payment.failed
      const failureReason =
        error instanceof Error ? error.message : String(error);

      await this.chargesRepository.updateStatus(chargeId, {
        status: "failed",
        failureReason,
        updatedAt: new Date(),
      });

      this.logger.warn({
        message: "Payment failed",
        chargeId,
        invoiceId,
        failureReason,
        attemptNumber,
        correlationId,
      });

      const failDualWriteMetadata =
        await this.dualWriteService?.getDualWriteMetadata(invoice.customerId);

      try {
        await this.sqsProducerService.publish(
          "payment.failed",
          {
            invoiceId,
            customerId: invoice.customerId,
            monolithCustomerId: customer.monolithCustomerId,
            amountCents: invoice.totalAmountCents,
            currency: invoice.currency,
            failureReason,
            attemptNumber,
          },
          correlationId,
          failDualWriteMetadata,
        );
      } catch (publishError) {
        if (failDualWriteMetadata) {
          await this.dualWriteService?.logDualWriteFailure(
            invoice.customerId,
            "payment.failed",
            { invoiceId, failureReason },
            publishError,
            correlationId,
          );
        } else {
          throw publishError;
        }
      }

      // Schedule dunning retry for subscription invoices on first attempt
      if (
        this.dunningService &&
        invoice.subscriptionId &&
        attemptNumber === 1
      ) {
        try {
          await this.dunningService.scheduleDunningAttempt(
            invoiceId,
            correlationId,
          );
        } catch (dunningError) {
          this.logger.warn({
            message: "Failed to schedule dunning attempt",
            invoiceId,
            error:
              dunningError instanceof Error
                ? dunningError.message
                : String(dunningError),
            correlationId,
          });
        }
      }

      return {
        chargeId,
        status: "failed",
        stripePaymentIntentId: null,
        failureReason,
      };
    }
  }

  async createOneTimeCharge(
    dto: CreateOneTimeChargeDto,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<OneTimeChargeResponseDto> {
    // 1. Check idempotency — return existing result if duplicate key
    const existingCharge =
      await this.chargesRepository.findByIdempotencyKey(idempotencyKey);

    if (existingCharge) {
      this.logger.log({
        message: "Returning existing one-time charge (idempotency hit)",
        idempotencyKey,
        chargeId: existingCharge.id,
        correlationId,
      });

      const invoice = await this.loadInvoiceWithLineItems(
        existingCharge.invoiceId,
      );

      return {
        charge: this.toResponseDto(existingCharge),
        invoice: invoice!,
      };
    }

    // 2. Validate customer exists
    const customer = await this.customersService.findById(dto.customerId);
    if (!customer) {
      throw new CustomerNotFoundException(dto.customerId);
    }

    // 3. Resolve payment method
    let paymentMethodId: string;
    let stripePaymentMethodId: string;
    let pmGatewayProvider: GatewayProvider = GatewayProvider.Stripe;

    if (dto.paymentMethodId) {
      // Look up the specific payment method by ID and verify customer ownership
      const pm = await this.paymentMethodsRepository.findById(
        dto.paymentMethodId,
      );
      if (!pm || pm.customerId !== dto.customerId) {
        throw new NoPaymentMethodException(dto.customerId);
      }
      paymentMethodId = pm.id;
      stripePaymentMethodId = pm.stripePaymentMethodId;
      pmGatewayProvider = pm.gatewayProvider as GatewayProvider;
    } else {
      const pm = await this.paymentMethodsService.getDefaultPaymentMethod(
        dto.customerId,
      );
      if (!pm) {
        throw new NoPaymentMethodException(dto.customerId);
      }
      paymentMethodId = pm.id;
      stripePaymentMethodId = pm.stripePaymentMethodId;
      pmGatewayProvider = pm.gatewayProvider as GatewayProvider;
    }

    const gatewayCustomerId =
      await this.paymentMethodsService.resolveGatewayCustomerId(
        dto.customerId,
        pmGatewayProvider,
        customer,
      );

    // 4. Create invoice with single line item within a transaction
    const invoiceId = generateId();
    const now = new Date();

    await this.db.transaction(async (tx) => {
      await this.invoicesRepository.create(
        {
          id: invoiceId,
          customerId: dto.customerId,
          subscriptionId: null,
          status: "draft",
          totalAmountCents: 0,
          currency: "usd",
          billingPeriodStart: now,
          billingPeriodEnd: now,
          dueDate: now,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        },
        tx,
      );

      await this.invoicesRepository.createLineItem(
        {
          id: generateId(),
          invoiceId,
          type: "one_time_charge",
          description: dto.description,
          amountCents: dto.amountCents,
          quantity: 1,
          createdAt: now,
        },
        tx,
      );

      validateTransition(
        "draft" as InvoiceStatus,
        "finalized" as InvoiceStatus,
        INVOICE_TRANSITIONS,
      );

      await this.invoicesRepository.update(
        invoiceId,
        {
          totalAmountCents: dto.amountCents,
          status: "finalized",
          updatedAt: now,
        },
        tx,
      );

      await this.ledgerService.recordInvoiceFinalized(
        invoiceId,
        dto.amountCents,
        "usd",
        correlationId,
        tx,
      );
    });

    this.logger.log({
      message: "One-time charge invoice created and finalized",
      invoiceId,
      customerId: dto.customerId,
      amountCents: dto.amountCents,
      idempotencyKey,
      correlationId,
    });

    // 5. Execute payment (outside transaction — Stripe-before-DB for charge)
    const chargeResult = await this.executePaymentForInvoiceWithPaymentMethod(
      invoiceId,
      dto.customerId,
      customer.monolithCustomerId,
      dto.amountCents,
      paymentMethodId,
      stripePaymentMethodId,
      gatewayCustomerId,
      idempotencyKey,
      correlationId,
      pmGatewayProvider,
    );

    // 6. Load and return full response
    const invoice = await this.loadInvoiceWithLineItems(invoiceId);
    const chargeRow = await this.chargesRepository.findById(
      chargeResult.chargeId,
    );

    if (!invoice) {
      throw new BusinessRuleViolationException(
        `Invoice ${invoiceId} not found after creation`,
      );
    }

    return {
      charge: this.toResponseDto(chargeRow!),
      invoice,
    };
  }

  async createOnboardingCharge(
    dto: CreateOnboardingChargeDto,
    correlationId: string,
  ): Promise<OnboardingChargeResponseDto> {
    // 1. Validate customer exists
    const customer = await this.customersService.findById(dto.customerId);
    if (!customer) {
      throw new CustomerNotFoundException(dto.customerId);
    }

    // 2. Validate scheduledDate is in the future
    const scheduledDate = new Date(dto.scheduledDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (scheduledDate <= today) {
      throw new BusinessRuleViolationException(
        "scheduledDate must be a future date",
      );
    }

    // 3. Create invoice with single line item (draft — no finalization, no payment)
    const invoiceId = generateId();
    const now = new Date();

    await this.db.transaction(async (tx) => {
      await this.invoicesRepository.create(
        {
          id: invoiceId,
          customerId: dto.customerId,
          subscriptionId: null,
          status: "draft",
          totalAmountCents: 0,
          currency: "usd",
          billingPeriodStart: scheduledDate,
          billingPeriodEnd: scheduledDate,
          dueDate: scheduledDate,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        },
        tx,
      );

      await this.invoicesRepository.createLineItem(
        {
          id: generateId(),
          invoiceId,
          type: "onboarding_fee",
          description: dto.description,
          amountCents: dto.amountCents,
          quantity: 1,
          createdAt: now,
        },
        tx,
      );

      await this.invoicesRepository.update(
        invoiceId,
        {
          totalAmountCents: dto.amountCents,
          updatedAt: now,
        },
        tx,
      );
    });

    this.logger.log({
      message: "Onboarding charge invoice created (draft)",
      invoiceId,
      customerId: dto.customerId,
      amountCents: dto.amountCents,
      scheduledDate: dto.scheduledDate,
      correlationId,
    });

    // 3. Load and return full response
    const invoice = await this.loadInvoiceWithLineItems(invoiceId);

    if (!invoice) {
      throw new BusinessRuleViolationException(
        `Invoice ${invoiceId} not found after creation`,
      );
    }

    return {
      invoice,
    };
  }

  private async executePaymentForInvoiceWithPaymentMethod(
    invoiceId: string,
    customerId: string,
    monolithCustomerId: string,
    amountCents: number,
    paymentMethodId: string,
    stripePaymentMethodId: string,
    gatewayCustomerId: string,
    idempotencyKey: string,
    correlationId: string,
    gatewayProvider: GatewayProvider = GatewayProvider.Stripe,
  ): Promise<ChargeResultDto> {
    const chargeId = generateId();
    const now = new Date();

    const { charge: createdCharge, isDuplicate } =
      await this.chargesRepository.createWithIdempotency({
        id: chargeId,
        invoiceId,
        customerId,
        paymentMethodId,
        amountCents,
        currency: "usd",
        status: "pending",
        idempotencyKey,
        attemptNumber: 1,
        createdAt: now,
        updatedAt: now,
      });

    if (isDuplicate) {
      this.logger.log({
        message: "Duplicate charge detected via idempotency key",
        idempotencyKey,
        invoiceId,
        correlationId,
      });
      return {
        chargeId: createdCharge.id,
        status: createdCharge.status as "pending" | "succeeded" | "failed",
        stripePaymentIntentId: createdCharge.stripePaymentIntentId,
      };
    }

    try {
      const gateway = this.gatewayRegistry.getAdapter(gatewayProvider);
      const gatewayResult = await gateway.createCharge({
        amount: amountCents,
        currency: "usd",
        customerId: gatewayCustomerId,
        paymentMethodId: stripePaymentMethodId,
        idempotencyKey,
        description: `One-time charge: Invoice ${invoiceId}`,
        metadata: {
          billingCustomerId: customerId,
          billingInvoiceId: invoiceId,
          monolithCustomerId,
        },
      });

      if (gatewayResult.status === "succeeded") {
        // Synchronous success (cards): update charge, invoice, ledger in one transaction
        await this.db.transaction(async (tx) => {
          await this.chargesRepository.updateStatus(
            chargeId,
            {
              status: "succeeded",
              stripePaymentIntentId: gatewayResult.id,
              updatedAt: new Date(),
            },
            tx,
          );

          validateTransition(
            "finalized" as InvoiceStatus,
            "paid" as InvoiceStatus,
            INVOICE_TRANSITIONS,
          );

          await this.invoicesRepository.update(
            invoiceId,
            {
              status: "paid",
              paidAt: new Date(),
              updatedAt: new Date(),
            },
            tx,
          );

          await this.ledgerService.recordPaymentSucceeded(
            chargeId,
            amountCents,
            "usd",
            correlationId,
            tx,
          );
        });

        this.logger.log({
          message: "One-time charge payment succeeded (synchronous)",
          chargeId,
          invoiceId,
          stripePaymentIntentId: gatewayResult.id,
          amountCents,
          correlationId,
        });

        // Publish events outside transaction
        const otcDualWriteMetadata =
          await this.dualWriteService?.getDualWriteMetadata(customerId);

        try {
          await this.sqsProducerService.publish(
            "payment.succeeded",
            {
              invoiceId,
              customerId,
              monolithCustomerId,
              amountCents,
              currency: "usd",
              paymentMethodId,
              stripePaymentIntentId: gatewayResult.id,
            },
            correlationId,
            otcDualWriteMetadata,
          );
        } catch (publishError) {
          if (otcDualWriteMetadata) {
            await this.dualWriteService?.logDualWriteFailure(
              customerId,
              "payment.succeeded",
              { invoiceId, amountCents },
              publishError,
              correlationId,
            );
          } else {
            throw publishError;
          }
        }

        try {
          await this.sqsProducerService.publish(
            "invoice.paid",
            {
              invoiceId,
              customerId,
              monolithCustomerId,
              totalAmountCents: amountCents,
              currency: "usd",
              paidAt: new Date().toISOString(),
            },
            correlationId,
            otcDualWriteMetadata,
          );
        } catch (publishError) {
          if (otcDualWriteMetadata) {
            await this.dualWriteService?.logDualWriteFailure(
              customerId,
              "invoice.paid",
              { invoiceId, totalAmountCents: amountCents },
              publishError,
              correlationId,
            );
          } else {
            throw publishError;
          }
        }

        return {
          chargeId,
          status: "succeeded" as const,
          stripePaymentIntentId: gatewayResult.id,
        };
      } else if (gatewayResult.status === "pending") {
        // Async payment (ACH): record PI ID, leave invoice as finalized — webhook will complete
        await this.chargesRepository.updateStatus(chargeId, {
          stripePaymentIntentId: gatewayResult.id,
          updatedAt: new Date(),
        });

        this.logger.log({
          message:
            "One-time charge payment pending (async) — waiting for webhook",
          chargeId,
          invoiceId,
          stripePaymentIntentId: gatewayResult.id,
          amountCents,
          correlationId,
        });

        return {
          chargeId,
          status: "pending" as const,
          stripePaymentIntentId: gatewayResult.id,
        };
      } else {
        // Gateway returned failed status
        await this.chargesRepository.updateStatus(chargeId, {
          status: "failed",
          stripePaymentIntentId: gatewayResult.id,
          failureReason:
            gatewayResult.failureMessage || "Payment declined by gateway",
          updatedAt: new Date(),
        });

        this.logger.warn({
          message: "One-time charge payment failed (gateway declined)",
          chargeId,
          invoiceId,
          stripePaymentIntentId: gatewayResult.id,
          failureReason: gatewayResult.failureMessage,
          correlationId,
        });

        return {
          chargeId,
          status: "failed" as const,
          stripePaymentIntentId: gatewayResult.id,
        };
      }
    } catch (error) {
      const failureReason =
        error instanceof Error ? error.message : String(error);

      await this.chargesRepository.updateStatus(chargeId, {
        status: "failed",
        failureReason,
        updatedAt: new Date(),
      });

      this.logger.warn({
        message: "One-time charge payment failed",
        chargeId,
        invoiceId,
        failureReason,
        correlationId,
      });

      const otcFailDualWriteMetadata =
        await this.dualWriteService?.getDualWriteMetadata(customerId);

      try {
        await this.sqsProducerService.publish(
          "payment.failed",
          {
            invoiceId,
            customerId,
            monolithCustomerId,
            amountCents,
            currency: "usd",
            failureReason,
            attemptNumber: 1,
          },
          correlationId,
          otcFailDualWriteMetadata,
        );
      } catch (publishError) {
        if (otcFailDualWriteMetadata) {
          await this.dualWriteService?.logDualWriteFailure(
            customerId,
            "payment.failed",
            { invoiceId, failureReason },
            publishError,
            correlationId,
          );
        } else {
          throw publishError;
        }
      }

      return {
        chargeId,
        status: "failed",
        stripePaymentIntentId: null,
        failureReason,
      };
    }
  }

  private async loadInvoiceWithLineItems(
    invoiceId: string,
  ): Promise<InvoiceResponseDto | null> {
    const result =
      await this.invoicesRepository.findByIdWithLineItems(invoiceId);

    if (!result) return null;

    const { invoice, lineItems } = result;

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
      lineItems: lineItems.map(
        (item): InvoiceLineItemResponseDto => ({
          id: item.id,
          invoiceId: item.invoiceId,
          type: item.type,
          description: item.description,
          amountCents: item.amountCents,
          quantity: item.quantity,
          breakdown: item.breakdown as Record<string, number> | null,
          createdAt: item.createdAt.toISOString(),
        }),
      ),
      createdAt: invoice.createdAt.toISOString(),
      updatedAt: invoice.updatedAt.toISOString(),
    };
  }

  async findByInvoiceId(invoiceId: string): Promise<ChargeResponseDto[]> {
    const results = await this.chargesRepository.findByInvoiceId(invoiceId);

    return results.map((charge) => this.toResponseDto(charge));
  }

  private toResponseDto(charge: {
    id: string;
    invoiceId: string;
    customerId: string;
    paymentMethodId: string;
    amountCents: number;
    currency: string;
    status: string;
    stripePaymentIntentId: string | null;
    idempotencyKey: string;
    failureReason: string | null;
    attemptNumber: number;
    createdAt: Date;
    updatedAt: Date;
  }): ChargeResponseDto {
    return {
      id: charge.id,
      invoiceId: charge.invoiceId,
      customerId: charge.customerId,
      paymentMethodId: charge.paymentMethodId,
      amountCents: charge.amountCents,
      currency: charge.currency,
      status: charge.status,
      stripePaymentIntentId: charge.stripePaymentIntentId,
      idempotencyKey: charge.idempotencyKey,
      failureReason: charge.failureReason,
      attemptNumber: charge.attemptNumber,
      createdAt: charge.createdAt.toISOString(),
      updatedAt: charge.updatedAt.toISOString(),
    };
  }
}
