import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiHeader,
} from "@nestjs/swagger";
import { Roles } from "../common/decorators/roles.decorator";
import { AdminRole } from "../common/enums/admin-role.enum";
import { BillingException } from "../common/exceptions/billing.exception";
import { RefundsService } from "./refunds.service";
import { CreateRefundDto } from "./dto/create-refund.dto";
import { RefundResponseDto } from "./dto/refund-response.dto";

@ApiTags("Refunds")
@ApiUnauthorizedResponse({ description: "Unauthorized" })
@ApiHeader({
  name: "x-admin-role",
  required: true,
  enum: ["cs", "finance", "admin"],
  description: "Admin role for RBAC",
})
@ApiHeader({
  name: "x-admin-user-id",
  required: false,
  description: "Admin user ID for audit trail",
})
@Controller("v1/admin/refunds")
export class RefundsController {
  constructor(private readonly refundsService: RefundsService) {}

  @Post()
  @Roles(AdminRole.Admin)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a refund" })
  @ApiCreatedResponse({ type: RefundResponseDto })
  @ApiBadRequestResponse({ description: "Missing x-idempotency-key header" })
  @ApiHeader({
    name: "x-idempotency-key",
    required: true,
    description: "Idempotency key for refund creation",
  })
  @ApiHeader({ name: "x-correlation-id", required: false })
  async createRefund(
    @Body() dto: CreateRefundDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<RefundResponseDto> {
    if (!idempotencyKey) {
      throw new BillingException(
        "x-idempotency-key header is required",
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.refundsService.createRefund(
      dto,
      idempotencyKey,
      correlationId ?? "no-correlation-id",
    );
  }

  @Get(":id")
  @Roles(AdminRole.Admin)
  @ApiOperation({ summary: "Get refund by ID" })
  @ApiOkResponse({ type: RefundResponseDto })
  @ApiNotFoundResponse({ description: "Refund not found" })
  async getRefund(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<RefundResponseDto> {
    const refund = await this.refundsService.findById(id);
    if (!refund) {
      throw new NotFoundException(`Refund ${id} not found`);
    }
    return refund;
  }
}
