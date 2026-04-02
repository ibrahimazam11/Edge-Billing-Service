import {
  Controller,
  Post,
  Get,
  Put,
  Param,
  Body,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
  ApiHeader,
} from "@nestjs/swagger";
import { SubscriptionsService } from "./subscriptions.service";
import { CreateSubscriptionDto } from "./dto/create-subscription.dto";
import { UpdateSubscriptionDto } from "./dto/update-subscription.dto";
import { SubscriptionQueryDto } from "./dto/subscription-query.dto";
import { SubscriptionResponseDto } from "./dto/subscription-response.dto";
import { SubscriptionManagementResponseDto } from "./dto/subscription-management-response.dto";
import type { PaginatedResult } from "../common/dto/pagination.dto";
import { SubscriptionNotFoundException } from "../common/exceptions/subscription-not-found.exception";
import { ApiPaginatedResponse } from "../common/decorators/api-paginated-response.decorator";

@ApiTags("Subscriptions")
@ApiUnauthorizedResponse({ description: "Unauthorized" })
@Controller("v1/subscriptions")
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create subscription" })
  @ApiCreatedResponse({ type: SubscriptionResponseDto })
  @ApiHeader({ name: "x-correlation-id", required: false })
  async create(
    @Body() dto: CreateSubscriptionDto,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<SubscriptionResponseDto> {
    return this.subscriptionsService.create(dto, correlationId);
  }

  @Put(":id")
  @ApiOperation({ summary: "Update subscription state" })
  @ApiOkResponse({ type: SubscriptionResponseDto })
  @ApiHeader({ name: "x-correlation-id", required: false })
  async updateState(
    @Param("id") id: string,
    @Body() dto: UpdateSubscriptionDto,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<SubscriptionResponseDto> {
    return this.subscriptionsService.updateState(id, dto, correlationId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get subscription by ID" })
  @ApiOkResponse({ type: SubscriptionResponseDto })
  @ApiNotFoundResponse({ description: "Subscription not found" })
  async findById(@Param("id") id: string): Promise<SubscriptionResponseDto> {
    const subscription = await this.subscriptionsService.findById(id);
    if (!subscription) {
      throw new SubscriptionNotFoundException(id);
    }
    return subscription;
  }

  @Get()
  @ApiOperation({ summary: "List subscriptions" })
  @ApiPaginatedResponse(SubscriptionManagementResponseDto)
  async findAll(
    @Query() query: SubscriptionQueryDto,
  ): Promise<PaginatedResult<SubscriptionManagementResponseDto>> {
    return this.subscriptionsService.findAll(query);
  }
}
