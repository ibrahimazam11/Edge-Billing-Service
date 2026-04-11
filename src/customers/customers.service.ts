import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from "../gateway/gateway.interface";
import { generateId } from "../common/utils/uuid.util";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import type { PaginatedResult } from "../common/dto/pagination.dto";
import type { CustomerQueryDto } from "./dto/customer-query.dto";
import type { CustomerResponseDto } from "./dto/customer-response.dto";
import type {
  CustomerCreatedPayload,
  CustomerUpdatedPayload,
} from "../integration/sqs/contracts/inbound-events";
import { CustomersRepository } from "./customers.repository";
import { customers } from "../database/schema/customers";

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly customersRepository: CustomersRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async createFromEvent(
    payload: CustomerCreatedPayload,
    correlationId: string,
  ): Promise<CustomerResponseDto> {
    this.logger.log({
      message: "Creating customer from event",
      monolithCustomerId: payload.monolithCustomerId,
      correlationId,
    });

    const existing = await this.findByMonolithId(payload.monolithCustomerId);
    if (existing) {
      this.logger.log({
        message: "Customer already exists, returning existing",
        monolithCustomerId: payload.monolithCustomerId,
        correlationId,
      });
      return existing;
    }

    const stripeCustomer = await this.gateway.createCustomer({
      email: payload.email,
      name: payload.name,
      metadata: payload.metadata as Record<string, string> | undefined,
    });

    const id = generateId();
    const now = new Date();

    const created = await this.customersRepository.create({
      id,
      monolithCustomerId: payload.monolithCustomerId,
      stripeCustomerId: stripeCustomer.id,
      name: payload.name,
      email: payload.email,
      status: "active",
      chargeDay: payload.chargeDay ?? 1,
      isPrepaid: payload.isPrepaid ?? true,
      metadata: payload.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    });

    this.logger.log({
      message: "Customer created successfully",
      customerId: id,
      stripeCustomerId: stripeCustomer.id,
      correlationId,
    });

    return this.toResponseDto(created);
  }

  async updateFromEvent(
    payload: CustomerUpdatedPayload,
    correlationId: string,
  ): Promise<CustomerResponseDto> {
    this.logger.log({
      message: "Updating customer from event",
      monolithCustomerId: payload.monolithCustomerId,
      correlationId,
    });

    const existing = await this.findByMonolithId(payload.monolithCustomerId);
    if (!existing) {
      throw new CustomerNotFoundException(payload.monolithCustomerId);
    }

    // Update Stripe FIRST — if Stripe fails, DB stays consistent and SQS will redeliver
    const stripeFields =
      payload.name !== undefined ||
      payload.email !== undefined ||
      payload.metadata !== undefined;
    if (stripeFields && existing.stripeCustomerId) {
      await this.gateway.updateCustomer(existing.stripeCustomerId, {
        email: payload.email,
        name: payload.name,
        metadata: payload.metadata as Record<string, string> | undefined,
      });
    }

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (payload.name !== undefined) {
      updateData.name = payload.name;
    }
    if (payload.email !== undefined) {
      updateData.email = payload.email;
    }
    if (payload.metadata !== undefined) {
      updateData.metadata = payload.metadata;
    }

    const updated = await this.customersRepository.update(
      existing.id,
      updateData,
    );

    this.logger.log({
      message: "Customer updated successfully",
      customerId: existing.id,
      correlationId,
    });

    return this.toResponseDto(updated);
  }

  async findById(id: string): Promise<CustomerResponseDto | null> {
    const customer = await this.customersRepository.findById(id);
    return customer ? this.toResponseDto(customer) : null;
  }

  async findByMonolithId(
    monolithCustomerId: string,
  ): Promise<CustomerResponseDto | null> {
    const customer =
      await this.customersRepository.findByMonolithId(monolithCustomerId);
    return customer ? this.toResponseDto(customer) : null;
  }

  async findAll(
    query: CustomerQueryDto,
  ): Promise<PaginatedResult<CustomerResponseDto>> {
    const limit = query.limit ?? 20;

    const results = await this.customersRepository.findAll(
      { status: query.status, cursor: query.cursor },
      limit,
    );

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const lastItem = data[data.length - 1];

    return {
      data: data.map((c) => this.toResponseDto(c)),
      cursor: hasMore && lastItem ? lastItem.id : null,
      hasMore,
    };
  }

  private toResponseDto(
    customer: typeof customers.$inferSelect,
  ): CustomerResponseDto {
    return {
      id: customer.id,
      monolithCustomerId: customer.monolithCustomerId,
      stripeCustomerId: customer.stripeCustomerId,
      name: customer.name,
      email: customer.email,
      status: customer.status,
      chargeDay: customer.chargeDay,
      isPrepaid: customer.isPrepaid,
      metadata: customer.metadata as Record<string, unknown> | null,
      createdAt: customer.createdAt.toISOString(),
      updatedAt: customer.updatedAt.toISOString(),
    };
  }
}
