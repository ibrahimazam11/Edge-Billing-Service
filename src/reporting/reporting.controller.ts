import { Controller, Get, Query } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { ReportingService } from "./reporting.service";
import { RevenueQueryDto } from "./dto/revenue-query.dto";
import { RevenueReportResponseDto } from "./dto/revenue-report-response.dto";
import { ReconciliationQueryDto } from "./dto/reconciliation-query.dto";
import { ReconciliationRunResponseDto } from "./dto/reconciliation-report-response.dto";
import type { PaginatedResult } from "../common/dto/pagination.dto";
import { DunningQueryDto } from "./dto/dunning-query.dto";
import { DunningReportResponseDto } from "./dto/dunning-report-response.dto";
import { DashboardReportResponseDto } from "./dto/dashboard-report-response.dto";
import { ApiPaginatedResponse } from "../common/decorators/api-paginated-response.decorator";

@ApiTags("Reports")
@ApiUnauthorizedResponse({ description: "Unauthorized" })
@Controller("v1/reports")
export class ReportingController {
  constructor(private readonly reportingService: ReportingService) {}

  @Get("revenue")
  @ApiOperation({ summary: "Get revenue report" })
  @ApiOkResponse({ type: RevenueReportResponseDto })
  async getRevenueReport(
    @Query() query: RevenueQueryDto,
  ): Promise<RevenueReportResponseDto> {
    return this.reportingService.getRevenueReport(
      query.startDate,
      query.endDate,
    );
  }

  @Get("reconciliation")
  @ApiOperation({ summary: "Get reconciliation report" })
  @ApiPaginatedResponse(ReconciliationRunResponseDto)
  async getReconciliationReport(
    @Query() query: ReconciliationQueryDto,
  ): Promise<PaginatedResult<ReconciliationRunResponseDto>> {
    return this.reportingService.getReconciliationReport(query);
  }

  @Get("dunning")
  @ApiOperation({ summary: "Get dunning report" })
  @ApiOkResponse({ type: DunningReportResponseDto })
  async getDunningReport(
    @Query() query: DunningQueryDto,
  ): Promise<DunningReportResponseDto> {
    return this.reportingService.getDunningReport(
      query.startDate,
      query.endDate,
    );
  }

  @Get("dashboard")
  @ApiOperation({ summary: "Get dashboard report" })
  @ApiOkResponse({ type: DashboardReportResponseDto })
  async getDashboardReport(): Promise<DashboardReportResponseDto> {
    return this.reportingService.getDashboardReport();
  }
}
