import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
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
import type { SetupIntentResponseDto } from "./dto/setup-intent-response.dto";
import {
  PAYMENT_METHOD_TYPE_CARD,
  PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
} from "../common/constants/payment-method-types";
import { PaymentMethodsRepository } from "./payment-methods.repository";
import { GatewayAssignmentsRepository } from "./gateway-assignments.repository";
import type { SetupIntentGateway } from "../gateway/gateway.interface";
// Use a token to avoid circular import — InvoicesModule provides InvoicesService
export const INVOICES_SERVICE = Symbol("INVOICES_SERVICE");

export interface ISurchargeRecalculator {
  recalculateSurchargeOnOpenInvoice(
    customerId: string,
    correlationId: string,
  ): Promise<void>;
}

@Injectable()
export class PaymentMethodsService {
  private readonly logger = new Logger(PaymentMethodsService.name);

  constructor(
    private readonly paymentMethodsRepository: PaymentMethodsRepository,
    private readonly gatewayAssignmentsRepository: GatewayAssignmentsRepository,
    private readonly gatewayRegistry: GatewayRegistry,
    private readonly customersService: CustomersService,
    @Optional()
    @Inject(INVOICES_SERVICE)
    private readonly invoicesService?: ISurchargeRecalculator,
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

    // Recalculate surcharge — PM type may have changed (or no PM left)
    await this.invoicesService?.recalculateSurchargeOnOpenInvoice(
      customerId,
      correlationId ?? "pm-detach",
    );
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

    // Recalculate surcharge on open invoice after PM change
    await this.invoicesService?.recalculateSurchargeOnOpenInvoice(
      customerId,
      correlationId ?? "pm-default-change",
    );

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

  // --- Setup Intent operations ---

  async createBankAccountSetup(
    customerId: string,
    input: {
      routingNumber: string;
      accountNumber: string;
      accountHolderType: "individual" | "company";
      accountType: "checking" | "savings";
      accountHolderName?: string;
    },
    correlationId?: string,
  ): Promise<SetupIntentResponseDto> {
    const { customer, gatewayCustomerId, gateway } =
      await this.resolveSetupContext(customerId);

    const result = await gateway.createBankAccountSetup({
      customerId: gatewayCustomerId,
      ...input,
      // Use customer name/email for billing_details — required by Stripe for US bank accounts
      accountHolderName: input.accountHolderName || customer.name,
      billingEmail: customer.email,
    });

    this.logger.log({
      message: "Bank account setup intent created",
      setupIntentId: result.id,
      customerId,
      correlationId,
    });

    return this.toSetupIntentResponse(result);
  }

  async createFinancialConnectionsSetup(
    customerId: string,
    correlationId?: string,
  ): Promise<SetupIntentResponseDto> {
    const { gatewayCustomerId, gateway } =
      await this.resolveSetupContext(customerId);

    const result = await gateway.createFinancialConnectionsSetup({
      customerId: gatewayCustomerId,
    });

    this.logger.log({
      message: "Financial connections setup intent created",
      setupIntentId: result.id,
      customerId,
      correlationId,
    });

    return this.toSetupIntentResponse(result);
  }

  async createCardSetup(
    customerId: string,
    correlationId?: string,
  ): Promise<SetupIntentResponseDto> {
    const { gatewayCustomerId, gateway } =
      await this.resolveSetupContext(customerId);

    const result = await gateway.createCardSetup({
      customerId: gatewayCustomerId,
    });

    this.logger.log({
      message: "Card setup intent created",
      setupIntentId: result.id,
      customerId,
      correlationId,
    });

    return this.toSetupIntentResponse(result);
  }

  async confirmSetupAndAttach(
    customerId: string,
    setupIntentId: string,
    correlationId?: string,
  ): Promise<PaymentMethodResponseDto> {
    const { gatewayCustomerId, gateway } =
      await this.resolveSetupContext(customerId);

    // Retrieve SI first — if already confirmed (manual ACH with confirm:true), skip confirm call
    let result = await gateway.retrieveSetupIntent({ setupIntentId });

    if (result.status !== "succeeded") {
      result = await gateway.confirmSetup({ setupIntentId });
    }

    if (!result.paymentMethodId) {
      throw new BusinessRuleViolationException(
        `SetupIntent ${setupIntentId} has no payment method after confirmation`,
      );
    }

    // Detach old default PM if exists (one PM at a time, matching monolith behavior)
    const existingDefault =
      await this.paymentMethodsRepository.getDefaultPaymentMethod(customerId);

    if (existingDefault) {
      const pmGateway = this.gatewayRegistry.getAdapter(
        existingDefault.gatewayProvider as GatewayProvider,
      );
      await pmGateway.detachPaymentMethod(
        existingDefault.stripePaymentMethodId,
      );
      await this.paymentMethodsRepository.updateStatus(
        existingDefault.id,
        "detached",
        { isDefault: false },
      );
    }

    // Set as default on gateway
    await this.gatewayRegistry
      .getAdapter(GatewayProvider.Stripe)
      .setDefaultPaymentMethod(gatewayCustomerId, result.paymentMethodId);

    // Fetch PM details from gateway
    const pmList = await this.gatewayRegistry
      .getAdapter(GatewayProvider.Stripe)
      .listPaymentMethods(gatewayCustomerId);
    const pmDetail = pmList.find((pm) => pm.id === result.paymentMethodId);

    const id = generateId();
    const now = new Date();

    const created = await this.paymentMethodsRepository.create({
      id,
      customerId,
      stripePaymentMethodId: result.paymentMethodId,
      type:
        pmDetail?.type === "card"
          ? PAYMENT_METHOD_TYPE_CARD
          : PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
      isDefault: true,
      lastFour: pmDetail?.last4 ?? null,
      brand: pmDetail?.brand ?? null,
      bankName: pmDetail?.bankName ?? null,
      expiryMonth: pmDetail?.expiryMonth ?? null,
      expiryYear: pmDetail?.expiryYear ?? null,
      gatewayProvider: GatewayProvider.Stripe,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    this.logger.log({
      message: "Setup intent confirmed and payment method attached",
      setupIntentId,
      paymentMethodId: result.paymentMethodId,
      customerId,
      correlationId,
    });

    // Recalculate surcharge — new default PM may be a different type
    await this.invoicesService?.recalculateSurchargeOnOpenInvoice(
      customerId,
      correlationId ?? "pm-setup-confirm",
    );

    return this.toResponseDto(created);
  }

  async verifySetupMicrodeposits(
    customerId: string,
    setupIntentId: string,
    amounts: [number, number],
    correlationId?: string,
  ): Promise<SetupIntentResponseDto> {
    const { gateway } = await this.resolveSetupContext(customerId);

    const result = await gateway.verifyMicrodeposits({
      setupIntentId,
      amounts,
    });

    this.logger.log({
      message: "Microdeposits verified",
      setupIntentId,
      customerId,
      correlationId,
    });

    return this.toSetupIntentResponse(result);
  }

  private async resolveSetupContext(customerId: string): Promise<{
    customer: { stripeCustomerId: string | null; name: string; email: string };
    gatewayCustomerId: string;
    gateway: SetupIntentGateway;
  }> {
    const customer = await this.customersService.findById(customerId);
    if (!customer) {
      throw new CustomerNotFoundException(customerId);
    }

    const gatewayCustomerId = await this.resolveGatewayCustomerId(
      customerId,
      GatewayProvider.Stripe,
      customer,
    );

    const gateway = this.gatewayRegistry.getAdapter(
      GatewayProvider.Stripe,
    ) as unknown as SetupIntentGateway;

    return { customer, gatewayCustomerId, gateway };
  }

  private toSetupIntentResponse(
    result: import("../gateway/gateway.types").SetupIntentResult,
  ): SetupIntentResponseDto {
    return {
      setupIntentId: result.id,
      clientSecret: result.clientSecret,
      status: result.status,
      paymentMethodId: result.paymentMethodId,
    };
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
