import { Inject, Injectable, Logger, Optional, forwardRef } from "@nestjs/common";
import { CustomersService } from "../customers/customers.service";
import { PaymentMethodsService } from "../payment-methods/payment-methods.service";
import { SqsProducerService } from "../integration/sqs/sqs-producer.service";
import { DualWriteService } from "../migration/dual-write.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SubscriptionsRepository } from "./subscriptions.repository";
import { subscriptions } from "../database/schema/subscriptions";
import { generateId } from "../common/utils/uuid.util";
import { calculateInvoiceDueDate, getBillingCycleDay } from "../common/utils/billing-date.util";
import { validateTransition } from "../common/utils/state-machine.util";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import { SubscriptionNotFoundException } from "../common/exceptions/subscription-not-found.exception";
import { StateTransitionException } from "../common/exceptions/billing.exception";
import { NoPaymentMethodException } from "../common/exceptions/no-payment-method.exception";
import type { PaginatedResult } from "../common/dto/pagination.dto";
import type { CreateSubscriptionDto } from "./dto/create-subscription.dto";
import type { UpdateSubscriptionDto } from "./dto/update-subscription.dto";
import type { SubscriptionResponseDto } from "./dto/subscription-response.dto";
import type { SubscriptionManagementResponseDto } from "./dto/subscription-management-response.dto";
import type { SubscriptionQueryDto } from "./dto/subscription-query.dto";
import type { SubscriptionCreatePayload } from "../integration/sqs/contracts/inbound-events";
import {
  SUBSCRIPTION_TRANSITIONS,
  type SubscriptionStatus,
} from "./subscription-state-machine";

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly subscriptionsRepository: SubscriptionsRepository,
    private readonly customersService: CustomersService,
    private readonly paymentMethodsService: PaymentMethodsService,
    private readonly sqsProducerService: SqsProducerService,
    @Inject(forwardRef(() => InvoicesService))
    private readonly invoicesService: InvoicesService,
    @Optional()
    private readonly dualWriteService?: DualWriteService,
  ) {}

  async create(
    dto: CreateSubscriptionDto,
    correlationId?: string,
  ): Promise<SubscriptionResponseDto> {
    const customer = await this.customersService.findById(dto.customerId);
    if (!customer) {
      throw new CustomerNotFoundException(dto.customerId);
    }

    const paymentMethods = await this.paymentMethodsService.findAll(
      dto.customerId,
      { limit: 1 },
    );
    if (paymentMethods.data.length === 0) {
      throw new NoPaymentMethodException(dto.customerId);
    }

    const billingPeriodStart = new Date(dto.billingStartDate);
    const billingPeriodEnd = this.calculateBillingPeriodEnd(billingPeriodStart);
    const nextBillingDate = calculateInvoiceDueDate(
      billingPeriodStart,
      customer.chargeDay,
      customer.isPrepaid,
    );

    const id = generateId();
    const now = new Date();

    const created = await this.subscriptionsRepository.create({
      id,
      customerId: dto.customerId,
      planName: dto.planName,
      status: "pending",
      amountCents: dto.amountCents,
      currency: dto.currency ?? "usd",
      billingInterval: dto.billingInterval ?? "monthly",
      billingPeriodStart,
      billingPeriodEnd,
      nextBillingDate,
      stripeSubscriptionId: null,
      metadata: dto.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    });

    this.logger.log({
      message: "Subscription created",
      subscriptionId: id,
      customerId: dto.customerId,
      planName: dto.planName,
      correlationId,
    });

    return this.toResponseDto(created);
  }

  /**
   * Called from SQS consumer on subscription.create event.
   * Creates subscription + first monthly invoice. Independent of onboarding charge.
   */
  async createFromEvent(
    payload: SubscriptionCreatePayload,
    billingCustomerId: string,
    correlationId: string,
  ): Promise<void> {
    const now = new Date();
    const onboardingDate = new Date(payload.onboardingDate);
    const currency = payload.currency ?? "usd";

    // Look up customer for chargeDay / isPrepaid
    const customer = await this.customersService.findById(billingCustomerId);
    const chargeDay = customer?.chargeDay ?? 15;
    const isPrepaid = customer?.isPrepaid ?? true;

    // Check if paused subscription exists — resume instead of creating new
    const existingSubs = await this.subscriptionsRepository.findByCustomerAndStatuses(
      billingCustomerId,
      ["paused"],
    );

    let subscriptionId: string;

    if (existingSubs.length > 0) {
      // Resume paused subscription and update pricing
      const pausedSub = existingSubs[0];
      subscriptionId = pausedSub.id;

      const newStart = new Date(payload.billingStartDate);
      const newEnd = this.calculateBillingPeriodEnd(newStart);
      const nextBillingDate = calculateInvoiceDueDate(newStart, chargeDay, isPrepaid);

      await this.subscriptionsRepository.updateStateWithConcurrencyCheck(
        pausedSub.id,
        {
          status: "active",
          amountCents: payload.amountCents,
          billingPeriodStart: newStart,
          billingPeriodEnd: newEnd,
          nextBillingDate,
          updatedAt: now,
        },
        "paused",
      );

      this.logger.log({
        message: "Paused subscription resumed",
        subscriptionId,
        customerId: billingCustomerId,
        correlationId,
      });
    } else {
      // Step 1: Create new subscription
      const firstBillingPeriodStart =
        this.calculateFirstBillingPeriodStart(onboardingDate, chargeDay);
      const billingPeriodEnd =
        this.calculateBillingPeriodEnd(firstBillingPeriodStart);
      const nextBillingDate = calculateInvoiceDueDate(
        firstBillingPeriodStart, chargeDay, isPrepaid,
      );

      subscriptionId = generateId();
      await this.subscriptionsRepository.create({
        id: subscriptionId,
        customerId: billingCustomerId,
        planName: payload.planName,
        status: "active",
        amountCents: payload.amountCents,
        currency,
        billingInterval: payload.billingInterval ?? "monthly",
        billingPeriodStart: firstBillingPeriodStart,
        billingPeriodEnd,
        nextBillingDate,
        stripeSubscriptionId: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      });

      this.logger.log({
        message: "Subscription created",
        subscriptionId,
        customerId: billingCustomerId,
        billingPeriodStart: firstBillingPeriodStart.toISOString(),
        nextBillingDate: nextBillingDate.toISOString(),
        correlationId,
      });
    }

    // Step 2: Create/update monthly invoice from payload employee data
    // Get current billing period from the subscription (works for both new and resumed)
    const sub = await this.subscriptionsRepository.findById(subscriptionId);
    const invoiceBillingStart = sub!.billingPeriodStart;
    const invoiceBillingEnd = sub!.billingPeriodEnd;
    const invoiceDueDate = calculateInvoiceDueDate(invoiceBillingStart, chargeDay, isPrepaid);

    const employees = payload.employees;
    const monthlyLineItems = employees?.length
      ? this.buildEmployeeLineItems(employees)
      : [];
    const invoiceTotalCents = employees?.length ? payload.amountCents : 0;

    if (!employees?.length) {
      this.logger.warn({
        message:
          "subscription.create received without employee data — creating empty draft (payroll.calculated will populate)",
        customerId: billingCustomerId,
        correlationId,
      });
    }

    // For resumed subscriptions, update existing open invoice instead of creating duplicate
    // If open invoice belongs to a different (e.g., canceled) subscription, void it and create fresh
    const existingOpenInvoice = await this.invoicesService.findOpenByCustomerId(billingCustomerId);
    if (existingOpenInvoice && existingOpenInvoice.subscriptionId === subscriptionId) {
      await this.invoicesService.updateOpenInvoiceLineItems(
        billingCustomerId,
        employees || [],
        invoiceTotalCents,
        correlationId,
      );
    } else {
      if (existingOpenInvoice) {
        await this.invoicesService.voidDraftInvoicesForCustomer(billingCustomerId, correlationId);
      }
      await this.invoicesService.createDraftInvoice(
        {
          customerId: billingCustomerId,
          subscriptionId,
          type: "recurring",
          lineItems: monthlyLineItems,
          totalAmountCents: invoiceTotalCents,
          currency,
          billingPeriodStart: invoiceBillingStart,
          billingPeriodEnd: invoiceBillingEnd,
          dueDate: invoiceDueDate,
        },
        correlationId,
      );
    }

    this.logger.log({
      message: "First monthly invoice created",
      subscriptionId,
      customerId: billingCustomerId,
      employeeCount: employees?.length ?? 0,
      totalAmountCents: invoiceTotalCents,
      dueDate: invoiceDueDate.toISOString(),
      correlationId,
    });
  }

  /**
   * Converts payroll employee data into invoice line items with breakdown columns.
   * One line item per employee — amountCents = customerCost, breakdown in separate fields.
   */
  private buildEmployeeLineItems(
    employees: Array<{
      employeeId: string;
      employeeName: string;
      customerCost: number;
      salary: number;
      platformFee: number;
      bonus: number;
      raise: number;
      discount: number;
    }>,
  ) {
    return employees.map((emp) => ({
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
    }));
  }

  /**
   * Calculates the first billing period start date using the customer's billing cycle day.
   * - If onboardingDate is in a future month → cycleDay of (that month + 1)
   * - If onboardingDate is in current or past month → cycleDay of (next month from today)
   */
  private calculateFirstBillingPeriodStart(onboardingDate: Date, chargeDay: number): Date {
    const cycleDay = getBillingCycleDay(chargeDay);
    const now = new Date();
    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth();
    const obYear = onboardingDate.getFullYear();
    const obMonth = onboardingDate.getMonth();

    let targetYear: number;
    let targetMonth: number;

    if (obYear > nowYear || (obYear === nowYear && obMonth > nowMonth)) {
      // Onboarding date is in a future month
      targetYear = obYear;
      targetMonth = obMonth + 1;
    } else {
      // Onboarding date is in current or past month
      targetYear = nowYear;
      targetMonth = nowMonth + 1;
    }

    // Handle year rollover
    if (targetMonth > 11) {
      targetMonth = 0;
      targetYear += 1;
    }

    // Clamp cycle day for short months (e.g., Feb)
    const maxDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const day = Math.min(cycleDay, maxDay);

    return new Date(Date.UTC(targetYear, targetMonth, day));
  }

  async findById(id: string): Promise<SubscriptionResponseDto | null> {
    const subscription = await this.subscriptionsRepository.findById(id);
    return subscription ? this.toResponseDto(subscription) : null;
  }

  async findAll(
    query: SubscriptionQueryDto,
  ): Promise<PaginatedResult<SubscriptionManagementResponseDto>> {
    const limit = query.limit ?? 20;

    const results = await this.subscriptionsRepository.findAllWithCustomer(
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

    return {
      data: data.map((row) => this.toManagementResponseDto(row)),
      cursor: hasMore && lastItem ? lastItem.subscription.id : null,
      hasMore,
    };
  }

  async updateState(
    id: string,
    dto: UpdateSubscriptionDto,
    correlationId?: string,
  ): Promise<SubscriptionResponseDto> {
    const existing = await this.subscriptionsRepository.findById(id);

    if (!existing) {
      throw new SubscriptionNotFoundException(id);
    }

    const currentState = existing.status as SubscriptionStatus;
    const targetState = dto.status as SubscriptionStatus;

    validateTransition(currentState, targetState, SUBSCRIPTION_TRANSITIONS);

    const now = new Date();
    let updateData: Partial<typeof subscriptions.$inferSelect>;

    if (targetState === "paused" || targetState === "canceled") {
      // Void unfinalized drafts; finalized invoices represent real debt and stay
      // in their lifecycle (ACH settles via webhook, dunning retries failed charges).
      await this.invoicesService.voidDraftInvoicesForCustomer(existing.customerId, correlationId);

      updateData = {
        status: targetState,
        nextBillingDate: null,
        updatedAt: now,
      };
    } else if (currentState === "paused" && targetState === "active") {
      const newEnd = this.calculateBillingPeriodEnd(now);
      updateData = {
        status: targetState,
        billingPeriodStart: now,
        billingPeriodEnd: newEnd,
        nextBillingDate: newEnd,
        updatedAt: now,
      };
    } else {
      updateData = {
        status: targetState,
        updatedAt: now,
      };
    }

    const updated =
      await this.subscriptionsRepository.updateStateWithConcurrencyCheck(
        id,
        updateData,
        currentState,
      );

    if (!updated) {
      throw new StateTransitionException(
        "Subscription state was modified concurrently",
        {
          currentState,
          targetState,
          allowedTransitions: SUBSCRIPTION_TRANSITIONS[currentState],
        },
      );
    }

    const dualWriteMetadata = await this.dualWriteService?.getDualWriteMetadata(
      existing.customerId,
    );

    try {
      await this.sqsProducerService.publish(
        "subscription.state.changed",
        {
          subscriptionId: id,
          customerId: existing.customerId,
          oldState: currentState,
          newState: targetState,
          changedAt: now.toISOString(),
        },
        correlationId ?? "",
        dualWriteMetadata,
      );
    } catch (publishError) {
      if (dualWriteMetadata) {
        await this.dualWriteService?.logDualWriteFailure(
          existing.customerId,
          "subscription.state.changed",
          { subscriptionId: id, oldState: currentState, newState: targetState },
          publishError,
          correlationId ?? "",
        );
      } else {
        throw publishError;
      }
    }

    this.logger.log({
      subscriptionId: id,
      customerId: existing.customerId,
      oldState: currentState,
      newState: targetState,
      correlationId,
      action: "subscription.state.changed",
    });

    return this.toResponseDto(updated);
  }

  async advanceBillingPeriod(
    subscriptionId: string,
    correlationId?: string,
  ): Promise<SubscriptionResponseDto> {
    const existing = await this.findById(subscriptionId);
    if (!existing) {
      throw new SubscriptionNotFoundException(subscriptionId);
    }

    const newStart = new Date(existing.billingPeriodEnd);
    const newEnd = this.calculateBillingPeriodEnd(newStart);
    const now = new Date();

    // Look up customer for chargeDay / isPrepaid to compute correct next billing date
    const customer = await this.customersService.findById(existing.customerId);
    const chargeDay = customer?.chargeDay ?? 15;
    const isPrepaid = customer?.isPrepaid ?? true;
    const nextBillingDate = calculateInvoiceDueDate(newStart, chargeDay, isPrepaid);

    const updated = await this.subscriptionsRepository.update(subscriptionId, {
      billingPeriodStart: newStart,
      billingPeriodEnd: newEnd,
      nextBillingDate,
      updatedAt: now,
    });

    this.logger.log({
      message: "Billing period advanced",
      subscriptionId,
      newStart: newStart.toISOString(),
      newEnd: newEnd.toISOString(),
      nextBillingDate: nextBillingDate.toISOString(),
      correlationId,
    });

    return this.toResponseDto(updated);
  }

  async updatePricing(
    customerId: string,
    amountCents: number,
    correlationId?: string,
  ): Promise<number> {
    if (amountCents <= 0 || !Number.isInteger(amountCents)) {
      this.logger.warn({
        message: "Invalid amountCents for pricing update — skipping",
        customerId,
        amountCents,
        correlationId,
      });
      return 0;
    }

    const existing =
      await this.subscriptionsRepository.findByCustomerAndStatuses(customerId, [
        "active",
        "paused",
      ]);

    if (existing.length === 0) {
      return 0;
    }

    const now = new Date();

    await this.subscriptionsRepository.updateByCustomerAndStatuses(
      customerId,
      ["active", "paused"],
      { amountCents, updatedAt: now },
    );

    for (const sub of existing) {
      this.logger.log({
        message: "Subscription pricing updated",
        subscriptionId: sub.id,
        customerId,
        oldAmount: sub.amountCents,
        newAmount: amountCents,
        action: "pricing.updated",
        correlationId,
      });
    }

    return existing.length;
  }

  private calculateBillingPeriodEnd(start: Date): Date {
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    if (end.getDate() !== start.getDate()) {
      end.setDate(0);
    }
    return end;
  }

  private toManagementResponseDto(row: {
    subscription: typeof subscriptions.$inferSelect;
    customerName: string | null;
    customerEmail: string | null;
  }): SubscriptionManagementResponseDto {
    return {
      ...this.toResponseDto(row.subscription),
      customerName: row.customerName ?? null,
      customerEmail: row.customerEmail ?? null,
    };
  }

  private toResponseDto(
    subscription: typeof subscriptions.$inferSelect,
  ): SubscriptionResponseDto {
    return {
      id: subscription.id,
      customerId: subscription.customerId,
      planName: subscription.planName,
      status: subscription.status,
      amountCents: subscription.amountCents,
      currency: subscription.currency,
      billingInterval: subscription.billingInterval,
      billingPeriodStart: subscription.billingPeriodStart.toISOString(),
      billingPeriodEnd: subscription.billingPeriodEnd.toISOString(),
      nextBillingDate: subscription.nextBillingDate?.toISOString() ?? null,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      metadata: subscription.metadata as Record<string, unknown> | null,
      createdAt: subscription.createdAt.toISOString(),
      updatedAt: subscription.updatedAt.toISOString(),
    };
  }
}
