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
  ApiUnauthorizedResponse,
  ApiHeader,
} from "@nestjs/swagger";
import { ChargesService } from "./charges.service";
import { CreateOnboardingChargeDto } from "./dto/create-onboarding-charge.dto";
import { OnboardingChargeResponseDto } from "./dto/onboarding-charge-response.dto";

@ApiTags("Onboarding Charges")
@ApiUnauthorizedResponse({ description: "Unauthorized" })
@Controller("v1/onboarding-charges")
export class OnboardingChargesController {
  constructor(private readonly chargesService: ChargesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create onboarding charge" })
  @ApiCreatedResponse({ type: OnboardingChargeResponseDto })
  @ApiHeader({ name: "x-correlation-id", required: false })
  async createOnboardingCharge(
    @Body() dto: CreateOnboardingChargeDto,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<OnboardingChargeResponseDto> {
    return this.chargesService.createOnboardingCharge(
      dto,
      correlationId ?? "no-correlation-id",
    );
  }
}
