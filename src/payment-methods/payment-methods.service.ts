import { Injectable, Logger } from "@nestjs/common";
import { GatewayRegistry } from "../gateway/gateway.registry";
import { GatewayProvider } from "../common/enums/gateway-provider.enum";
import { CustomersService } from "../customers/customers.service";
import { paymentMethods } from "../database/schema/payment-methods";
import { generateId } from "../common/utils/uuid.util";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import { PaymentMethodNotFoundException } from "../common/exceptions/payment-method-not-found.exception";
import { BusinessRuleViolationException } from "../common/exceptions/billing.exception";
import type { PaginatedResult } from "../common/dto/pagination.dto";
import type { CreatePaymentMethodDto } from "./dto/create-payment-method.dto";
import type { PaymentMethodResponseDto } from "./dto/payment-method-response.dto";
import type { PaymentMethodQueryDto } from "./dto/payment-method-query.dto";
import {
  PAYMENT_METHOD_TYPE_CARD,
  PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
} from "../common/constants/payment-method-types";
import { PaymentMethodsRepository } from "./payment-methods.repository";
import { GatewayAssignmentsRepository } from "./gateway-assignments.repository";

@Injectable()
export class PaymentMethodsService {
  private readonly logger = new Logger(PaymentMethodsService.name);

  constructor(
    private readonly paymentMethodsRepository: PaymentMethodsRepository,
    private readonly gatewayAssignmentsRepository: GatewayAssignmentsRepository,
    private readonly gatewayRegistry: GatewayRegistry,
    private readonly customersService: CustomersService,
  ) {}

  async attach(
    customerId: string,
    dto: CreatePaymentMethodDto,
    correlationId?: string,
  ): Promise<PaymentMethodResponseDto> {
    const customer = await this.customersService.findById(customerId);
    if (!customer) {
      throw new CustomerNotFoundException(customerId);
    }

    const gatewayProvider = await this.resolveCustomerGateway(customerId);
    const gateway = this.gatewayRegistry.getAdapter(gatewayProvider);
    const gatewayCustomerId = await this.resolveGatewayCustomerId(
      customerId,
      gatewayProvider,
      customer,
    );

    const gatewayResult = await gateway.attachPaymentMethod(
      dto.paymentMethodId,
      gatewayCustomerId,
    );

    const existingActive =
      await this.paymentMethodsRepository.findActiveByCustomer(customerId);
    const isFirst = !existingActive;

    if (isFirst) {
      await gateway.setDefaultPaymentMethod(
        gatewayCustomerId,
        gatewayResult.id,
      );
    }

    const id = generateId();
    const now = new Date();

    const created = await this.paymentMethodsRepository.create({
      id,
      customerId,
      stripePaymentMethodId: gatewayResult.id,
      type:
        gatewayResult.type === "card"
          ? PAYMENT_METHOD_TYPE_CARD
          : PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
      isDefault: isFirst,
      lastFour: gatewayResult.last4,
      brand: gatewayResult.brand,
      bankName: gatewayResult.bankName,
      expiryMonth: gatewayResult.expiryMonth,
      expiryYear: gatewayResult.expiryYear,
      gatewayProvider,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    this.logger.log({
      message: "Payment method attached",
      paymentMethodId: id,
      customerId,
      isDefault: isFirst,
      correlationId,
    });

    return this.toResponseDto(created);
  }

  async detach(
    customerId: string,
    paymentMethodId: string,
    correlationId?: string,
  ): Promise<void> {
    const customer = await this.customersService.findById(customerId);
    if (!customer) {
      throw new CustomerNotFoundException(customerId);
    }

    const pm = await this.findPaymentMethodOrThrow(customerId, paymentMethodId);
    const pmGatewayProvider = pm.gatewayProvider as GatewayProvider;
    const gateway = this.gatewayRegistry.getAdapter(pmGatewayProvider);

    await gateway.detachPaymentMethod(pm.stripePaymentMethodId);

    if (pm.isDefault) {
      const nextDefault = await this.paymentMethodsRepository.findNextDefault(
        customerId,
        paymentMethodId,
      );

      if (nextDefault) {
        const gatewayCustomerId = await this.resolveGatewayCustomerId(
          customerId,
          pmGatewayProvider,
          customer,
        );

        await gateway.setDefaultPaymentMethod(
          gatewayCustomerId,
          nextDefault.stripePaymentMethodId,
        );

        await this.paymentMethodsRepository.updateDefault(nextDefault.id, true);
      }
    }

    await this.paymentMethodsRepository.updateStatus(
      paymentMethodId,
      "detached",
      { isDefault: false },
    );

    this.logger.log({
      message: "Payment method detached",
      paymentMethodId,
      customerId,
      correlationId,
    });
  }

  async setDefault(
    customerId: string,
    paymentMethodId: string,
    correlationId?: string,
  ): Promise<PaymentMethodResponseDto> {
    const customer = await this.customersService.findById(customerId);
    if (!customer) {
      throw new CustomerNotFoundException(customerId);
    }

    const pm = await this.findPaymentMethodOrThrow(customerId, paymentMethodId);
    const pmGatewayProvider = pm.gatewayProvider as GatewayProvider;
    const gateway = this.gatewayRegistry.getAdapter(pmGatewayProvider);
    const gatewayCustomerId = await this.resolveGatewayCustomerId(
      customerId,
      pmGatewayProvider,
      customer,
    );

    await gateway.setDefaultPaymentMethod(
      gatewayCustomerId,
      pm.stripePaymentMethodId,
    );

    await this.paymentMethodsRepository.clearDefaults(customerId);
    const updated = await this.paymentMethodsRepository.updateDefault(
      paymentMethodId,
      true,
    );

    this.logger.log({
      message: "Default payment method set",
      paymentMethodId,
      customerId,
      correlationId,
    });

    return this.toResponseDto(updated);
  }

  async findAll(
    customerId: string,
    query: PaymentMethodQueryDto,
  ): Promise<PaginatedResult<PaymentMethodResponseDto>> {
    const customer = await this.customersService.findById(customerId);
    if (!customer) {
      throw new CustomerNotFoundException(customerId);
    }

    const limit = query.limit ?? 20;
    const results = await this.paymentMethodsRepository.findAllByCustomer(
      customerId,
      { cursor: query.cursor },
      limit,
    );

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const lastItem = data[data.length - 1];

    return {
      data: data.map((pm) => this.toResponseDto(pm)),
      cursor: hasMore && lastItem ? lastItem.id : null,
      hasMore,
    };
  }

  async getDefaultPaymentMethod(
    customerId: string,
  ): Promise<PaymentMethodResponseDto | null> {
    const pm =
      await this.paymentMethodsRepository.getDefaultPaymentMethod(customerId);
    return pm ? this.toResponseDto(pm) : null;
  }

  async getOrderedPaymentMethods(
    customerId: string,
  ): Promise<PaymentMethodResponseDto[]> {
    const results =
      await this.paymentMethodsRepository.getOrderedByCustomer(customerId);
    return results.map((pm) => this.toResponseDto(pm));
  }

  async getActivePaymentMethodById(
    customerId: string,
    paymentMethodId: string,
  ): Promise<PaymentMethodResponseDto> {
    const pm = await this.findPaymentMethodOrThrow(customerId, paymentMethodId);
    return this.toResponseDto(pm);
  }

  async updateFallbackOrder(
    customerId: string,
    paymentMethodId: string,
    fallbackOrder: number | null,
  ): Promise<PaymentMethodResponseDto> {
    await this.findPaymentMethodOrThrow(customerId, paymentMethodId);

    const updated = await this.paymentMethodsRepository.updateFallbackOrder(
      paymentMethodId,
      fallbackOrder,
    );

    this.logger.log({
      message: "Fallback order updated",
      paymentMethodId,
      customerId,
      fallbackOrder,
    });

    return this.toResponseDto(updated);
  }

  private async resolveCustomerGateway(
    customerId: string,
  ): Promise<GatewayProvider> {
    const assignments =
      await this.gatewayAssignmentsRepository.findByCustomer(customerId);
    const assignment = assignments[0] ?? null;

    if (assignment) {
      return assignment.gatewayProvider as GatewayProvider;
    }
    return GatewayProvider.Stripe;
  }

  async resolveGatewayCustomerId(
    customerId: string,
    gatewayProvider: GatewayProvider,
    customer: { stripeCustomerId: string | null },
  ): Promise<string> {
    if (gatewayProvider === GatewayProvider.Stripe) {
      if (!customer.stripeCustomerId) {
        throw new BusinessRuleViolationException(
          `Customer ${customerId} has no linked Stripe account`,
        );
      }
      return customer.stripeCustomerId;
    }
    const assignment =
      await this.gatewayAssignmentsRepository.findByCustomerAndProvider(
        customerId,
        gatewayProvider,
      );
    if (!assignment) {
      throw new BusinessRuleViolationException(
        `Customer ${customerId} has no ${gatewayProvider} gateway assignment`,
      );
    }
    return assignment.gatewayCustomerId;
  }

  private async findPaymentMethodOrThrow(
    customerId: string,
    paymentMethodId: string,
  ): Promise<typeof paymentMethods.$inferSelect> {
    const pm = await this.paymentMethodsRepository.findByIdAndCustomer(
      paymentMethodId,
      customerId,
    );
    if (!pm) {
      throw new PaymentMethodNotFoundException(paymentMethodId);
    }
    return pm;
  }

  private toResponseDto(
    pm: typeof paymentMethods.$inferSelect,
  ): PaymentMethodResponseDto {
    return {
      id: pm.id,
      customerId: pm.customerId,
      stripePaymentMethodId: pm.stripePaymentMethodId,
      type: pm.type,
      isDefault: pm.isDefault,
      lastFour: pm.lastFour,
      brand: pm.brand,
      bankName: pm.bankName,
      expiryMonth: pm.expiryMonth,
      expiryYear: pm.expiryYear,
      fallbackOrder: pm.fallbackOrder ?? null,
      gatewayProvider: pm.gatewayProvider,
      status: pm.status,
      createdAt: pm.createdAt.toISOString(),
      updatedAt: pm.updatedAt.toISOString(),
    };
  }
}
