import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
  ApiHeader,
} from "@nestjs/swagger";
import { InvoicesService } from "./invoices.service";
import { InvoiceQueryDto } from "./dto/invoice-query.dto";
import { InvoiceResponseDto } from "./dto/invoice-response.dto";
import type { PaginatedResult } from "../common/dto/pagination.dto";
import { InvoiceNotFoundException } from "./invoice-not-found.exception";
import { ApiPaginatedResponse } from "../common/decorators/api-paginated-response.decorator";

@ApiTags("Invoices")
@ApiUnauthorizedResponse({ description: "Unauthorized" })
@Controller("v1/invoices")
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get(":id")
  @ApiOperation({ summary: "Get invoice by ID" })
  @ApiOkResponse({ type: InvoiceResponseDto })
  @ApiNotFoundResponse({ description: "Invoice not found" })
  async findById(@Param("id") id: string): Promise<InvoiceResponseDto> {
    const invoice = await this.invoicesService.findById(id);
    if (!invoice) {
      throw new InvoiceNotFoundException(id);
    }
    return invoice;
  }

  @Post(":id/void")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Void an invoice" })
  @ApiOkResponse({ type: InvoiceResponseDto })
  @ApiHeader({ name: "x-correlation-id", required: false })
  async voidInvoice(
    @Param("id") id: string,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<InvoiceResponseDto> {
    return this.invoicesService.voidInvoice(id, correlationId);
  }

  @Get()
  @ApiOperation({ summary: "List invoices" })
  @ApiPaginatedResponse(InvoiceResponseDto)
  async findAll(
    @Query() query: InvoiceQueryDto,
  ): Promise<PaginatedResult<InvoiceResponseDto>> {
    return this.invoicesService.findAll(query);
  }
}
