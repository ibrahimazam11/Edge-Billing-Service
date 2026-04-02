import { Injectable, Logger, Optional } from "@nestjs/common";
import { CustomersService } from "../customers/customers.service";
import { PaymentMethodsService } from "../payment-methods/payment-methods.service";
import { SqsProducerService } from "../integration/sqs/sqs-producer.service";
import { DualWriteService } from "../migration/dual-write.service";
import { SubscriptionsRepository } from "./subscriptions.repository";
import { subscriptions } from "../database/schema/subscriptions";
import { generateId } from "../common/utils/uuid.util";
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
      nextBillingDate: billingPeriodEnd,
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

    if (targetState === "paused") {
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

    const updated = await this.subscriptionsRepository.update(subscriptionId, {
      billingPeriodStart: newStart,
      billingPeriodEnd: newEnd,
      nextBillingDate: newEnd,
      updatedAt: now,
    });

    this.logger.log({
      message: "Billing period advanced",
      subscriptionId,
      newStart: newStart.toISOString(),
      newEnd: newEnd.toISOString(),
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
