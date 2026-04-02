import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiUnauthorizedResponse,
  ApiHeader,
} from "@nestjs/swagger";
import { CreditsService } from "./credits.service";
import { IssueCreditNoteDto } from "./dto/issue-credit-note.dto";
import { CreditNoteResponseDto } from "./dto/credit-note-response.dto";
import { CreditBalanceResponseDto } from "./dto/credit-balance-response.dto";

@ApiTags("Credits")
@ApiUnauthorizedResponse({ description: "Unauthorized" })
@Controller("v1")
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  @Post("credit-notes")
  @ApiOperation({ summary: "Issue a credit note" })
  @ApiCreatedResponse({ type: CreditNoteResponseDto })
  @ApiHeader({ name: "x-correlation-id", required: false })
  async createCreditNote(
    @Body() dto: IssueCreditNoteDto,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<CreditNoteResponseDto> {
    return this.creditsService.issueCreditNote(dto, correlationId ?? "unknown");
  }

  @Get("customers/:id/credit-balance")
  @ApiOperation({ summary: "Get customer credit balance" })
  @ApiOkResponse({ type: CreditBalanceResponseDto })
  async getCreditBalance(
    @Param("id", ParseUUIDPipe) customerId: string,
  ): Promise<CreditBalanceResponseDto> {
    return this.creditsService.getCreditBalance(customerId);
  }
}
