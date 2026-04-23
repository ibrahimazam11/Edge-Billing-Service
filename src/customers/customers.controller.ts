import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { CustomersService } from "./customers.service";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import type { PaginatedResult } from "../common/dto/pagination.dto";
import { CustomerQueryDto } from "./dto/customer-query.dto";
import { CustomerResponseDto } from "./dto/customer-response.dto";
import { ApiPaginatedResponse } from "../common/decorators/api-paginated-response.decorator";

@ApiTags("Customers")
@ApiUnauthorizedResponse({ description: "Unauthorized" })
@Controller("v1/customers")
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get("by-monolith-id/:monolithCustomerId")
  @ApiOperation({ summary: "Get customer by monolith customer ID" })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: "Customer not found" })
  async findByMonolithId(
    @Param("monolithCustomerId") monolithCustomerId: string,
  ): Promise<CustomerResponseDto> {
    const customer =
      await this.customersService.findByMonolithId(monolithCustomerId);
    if (!customer) {
      throw new CustomerNotFoundException(monolithCustomerId);
    }
    return customer;
  }

  @Get("by-stripe-id/:stripeCustomerId")
  @ApiOperation({ summary: "Get customer by Stripe customer ID" })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: "Customer not found" })
  async findByStripeCustomerId(
    @Param("stripeCustomerId") stripeCustomerId: string,
  ): Promise<CustomerResponseDto> {
    const customer =
      await this.customersService.findByStripeCustomerId(stripeCustomerId);
    if (!customer) {
      throw new CustomerNotFoundException(stripeCustomerId);
    }
    return customer;
  }

  @Get(":id")
  @ApiOperation({ summary: "Get customer by ID" })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: "Customer not found" })
  async findById(@Param("id") id: string): Promise<CustomerResponseDto> {
    const customer = await this.customersService.findById(id);
    if (!customer) {
      throw new CustomerNotFoundException(id);
    }
    return customer;
  }

  @Get()
  @ApiOperation({ summary: "List customers" })
  @ApiPaginatedResponse(CustomerResponseDto)
  async findAll(
    @Query() query: CustomerQueryDto,
  ): Promise<PaginatedResult<CustomerResponseDto>> {
    return this.customersService.findAll(query);
  }
}
