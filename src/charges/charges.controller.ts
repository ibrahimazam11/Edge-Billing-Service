import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiHeader,
} from "@nestjs/swagger";
import { ChargesService } from "./charges.service";
import { CreateOneTimeChargeDto } from "./dto/create-one-time-charge.dto";
import { OneTimeChargeResponseDto } from "./dto/one-time-charge-response.dto";
import { BillingException } from "../common/exceptions/billing.exception";

@ApiTags("Charges")
@ApiUnauthorizedResponse({ description: "Unauthorized" })
@Controller("v1/charges")
export class ChargesController {
  constructor(private readonly chargesService: ChargesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create one-time charge" })
  @ApiCreatedResponse({ type: OneTimeChargeResponseDto })
  @ApiBadRequestResponse({ description: "Missing x-idempotency-key header" })
  @ApiHeader({
    name: "x-idempotency-key",
    required: true,
    description: "Idempotency key for charge creation",
  })
  @ApiHeader({ name: "x-correlation-id", required: false })
  async createOneTimeCharge(
    @Body() dto: CreateOneTimeChargeDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<OneTimeChargeResponseDto> {
    if (!idempotencyKey) {
      throw new BillingException(
        "x-idempotency-key header is required",
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.chargesService.createOneTimeCharge(
      dto,
      idempotencyKey,
      correlationId ?? "no-correlation-id",
    );
  }
}
