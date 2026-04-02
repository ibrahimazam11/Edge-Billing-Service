import {
  Controller,
  Post,
  Delete,
  Put,
  Get,
  Param,
  Body,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiNoContentResponse,
  ApiUnauthorizedResponse,
  ApiHeader,
  ApiParam,
} from "@nestjs/swagger";
import { PaymentMethodsService } from "./payment-methods.service";
import { CreatePaymentMethodDto } from "./dto/create-payment-method.dto";
import { UpdateFallbackOrderDto } from "./dto/update-fallback-order.dto";
import { PaymentMethodQueryDto } from "./dto/payment-method-query.dto";
import { PaymentMethodResponseDto } from "./dto/payment-method-response.dto";
import type { PaginatedResult } from "../common/dto/pagination.dto";
import { ApiPaginatedResponse } from "../common/decorators/api-paginated-response.decorator";

@ApiTags("Payment Methods")
@ApiUnauthorizedResponse({ description: "Unauthorized" })
@ApiParam({ name: "customerId", description: "Customer UUID" })
@Controller("v1/customers/:customerId/payment-methods")
export class PaymentMethodsController {
  constructor(private readonly paymentMethodsService: PaymentMethodsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Attach payment method to customer" })
  @ApiCreatedResponse({ type: PaymentMethodResponseDto })
  @ApiHeader({ name: "x-correlation-id", required: false })
  async attach(
    @Param("customerId") customerId: string,
    @Body() dto: CreatePaymentMethodDto,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<PaymentMethodResponseDto> {
    return this.paymentMethodsService.attach(customerId, dto, correlationId);
  }

  @Delete(":pmId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Detach payment method from customer" })
  @ApiNoContentResponse({ description: "Payment method detached" })
  @ApiHeader({ name: "x-correlation-id", required: false })
  async detach(
    @Param("customerId") customerId: string,
    @Param("pmId") pmId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<void> {
    await this.paymentMethodsService.detach(customerId, pmId, correlationId);
  }

  @Put(":pmId/default")
  @ApiOperation({ summary: "Set default payment method" })
  @ApiOkResponse({ type: PaymentMethodResponseDto })
  @ApiHeader({ name: "x-correlation-id", required: false })
  async setDefault(
    @Param("customerId") customerId: string,
    @Param("pmId") pmId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<PaymentMethodResponseDto> {
    return this.paymentMethodsService.setDefault(
      customerId,
      pmId,
      correlationId,
    );
  }

  @Put(":pmId/fallback-order")
  @ApiOperation({ summary: "Update fallback order for payment method" })
  @ApiOkResponse({ type: PaymentMethodResponseDto })
  async updateFallbackOrder(
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Param("pmId", ParseUUIDPipe) pmId: string,
    @Body() dto: UpdateFallbackOrderDto,
  ): Promise<PaymentMethodResponseDto> {
    return this.paymentMethodsService.updateFallbackOrder(
      customerId,
      pmId,
      dto.fallbackOrder ?? null,
    );
  }

  @Get()
  @ApiOperation({ summary: "List customer payment methods" })
  @ApiPaginatedResponse(PaymentMethodResponseDto)
  async findAll(
    @Param("customerId") customerId: string,
    @Query() query: PaymentMethodQueryDto,
  ): Promise<PaginatedResult<PaymentMethodResponseDto>> {
    return this.paymentMethodsService.findAll(customerId, query);
  }
}
