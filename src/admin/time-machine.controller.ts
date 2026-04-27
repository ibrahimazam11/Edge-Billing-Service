import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
} from "@nestjs/swagger";
import { Public } from "../common/decorators/public.decorator";
import { TimeMachineService } from "./time-machine.service";
import { AdvanceCycleRequestDto } from "./dto/advance-cycle-request.dto";
import type { AdvanceCycleResponseDto } from "./dto/advance-cycle-response.dto";

@ApiTags("Admin — Time Machine")
@Controller("v1/admin/time-machine")
export class TimeMachineController {
  constructor(private readonly timeMachineService: TimeMachineService) {}

  // Auth intentionally disabled on this endpoint for local/dev testing —
  // the service-level assertNonProduction() still blocks execution in prod.
  // Revisit before any non-dev deploy.
  @Post("advance-cycle")
  @HttpCode(HttpStatus.OK)
  @Public()
  @ApiOperation({
    summary: "Fast-forward a BS customer through one billing cycle",
    description:
      "Sets subscription.nextBillingDate to NOW, invokes the real scheduler handler (generates invoice, charges via real Stripe, advances period on success). Non-production only. One call = one cycle.",
  })
  @ApiOkResponse({
    description:
      "Cycle triggered. Response captures before/after subscription state, the generated invoice, and any notes (e.g. async ACH).",
  })
  @ApiForbiddenResponse({
    description: "Disabled in production",
  })
  @ApiNotFoundResponse({
    description: "Customer or active subscription not found",
  })
  @ApiConflictResponse({
    description: "Subscription is paused or canceled — resume before advancing",
  })
  async advanceCycle(
    @Body() body: AdvanceCycleRequestDto,
  ): Promise<AdvanceCycleResponseDto> {
    return this.timeMachineService.advanceCycle(body.monolithCustomerId);
  }
}
