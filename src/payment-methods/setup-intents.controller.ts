import {
  Controller,
  Post,
  Param,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiUnauthorizedResponse,
  ApiHeader,
  ApiParam,
} from "@nestjs/swagger";
import { PaymentMethodsService } from "./payment-methods.service";
import { CreateBankAccountSetupDto } from "./dto/create-bank-account-setup.dto";
import { VerifyMicrodepositsDto } from "./dto/verify-microdeposits.dto";
import type { SetupIntentResponseDto } from "./dto/setup-intent-response.dto";
import type { PaymentMethodResponseDto } from "./dto/payment-method-response.dto";

@ApiTags("Setup Intents")
@ApiUnauthorizedResponse({ description: "Unauthorized" })
@ApiParam({ name: "customerId", description: "Customer UUID" })
@Controller("v1/customers/:customerId/setup-intents")
export class SetupIntentsController {
  constructor(private readonly paymentMethodsService: PaymentMethodsService) {}

  @Post("financial-connections")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create Financial Connections setup intent" })
  @ApiCreatedResponse({
    description: "SetupIntent created with client_secret for frontend",
  })
  @ApiHeader({ name: "x-correlation-id", required: false })
  async createFinancialConnections(
    @Param("customerId") customerId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<SetupIntentResponseDto> {
    return this.paymentMethodsService.createFinancialConnectionsSetup(
      customerId,
      correlationId,
    );
  }

  @Post("manual-ach")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create Manual ACH setup intent with bank details" })
  @ApiCreatedResponse({
    description: "SetupIntent created and confirmed with bank details",
  })
  @ApiHeader({ name: "x-correlation-id", required: false })
  async createManualAch(
    @Param("customerId") customerId: string,
    @Body() dto: CreateBankAccountSetupDto,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<SetupIntentResponseDto> {
    return this.paymentMethodsService.createBankAccountSetup(
      customerId,
      dto,
      correlationId,
    );
  }

  @Post("credit-card")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create credit card setup intent" })
  @ApiCreatedResponse({
    description: "SetupIntent created with client_secret for Stripe.js",
  })
  @ApiHeader({ name: "x-correlation-id", required: false })
  async createCreditCard(
    @Param("customerId") customerId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<SetupIntentResponseDto> {
    return this.paymentMethodsService.createCardSetup(
      customerId,
      correlationId,
    );
  }

  @Post(":setupIntentId/confirm")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Confirm setup intent and attach payment method" })
  @ApiOkResponse({ description: "Payment method attached and set as default" })
  @ApiHeader({ name: "x-correlation-id", required: false })
  @ApiParam({ name: "setupIntentId", description: "Setup Intent ID" })
  async confirm(
    @Param("customerId") customerId: string,
    @Param("setupIntentId") setupIntentId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<PaymentMethodResponseDto> {
    return this.paymentMethodsService.confirmSetupAndAttach(
      customerId,
      setupIntentId,
      correlationId,
    );
  }

  @Post(":setupIntentId/verify-microdeposits")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify microdeposits for manual ACH setup intent" })
  @ApiOkResponse({ description: "Microdeposits verified" })
  @ApiHeader({ name: "x-correlation-id", required: false })
  @ApiParam({ name: "setupIntentId", description: "Setup Intent ID" })
  async verifyMicrodeposits(
    @Param("customerId") customerId: string,
    @Param("setupIntentId") setupIntentId: string,
    @Body() dto: VerifyMicrodepositsDto,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<SetupIntentResponseDto> {
    return this.paymentMethodsService.verifySetupMicrodeposits(
      customerId,
      setupIntentId,
      dto.amounts,
      correlationId,
    );
  }
}
