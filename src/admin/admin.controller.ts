import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiUnauthorizedResponse,
  ApiHeader,
} from "@nestjs/swagger";
import { Roles } from "../common/decorators/roles.decorator";
import { AdminRole } from "../common/enums/admin-role.enum";
import type { PaginatedResult } from "../common/dto/pagination.dto";
import { AdminService } from "./admin.service";
import { CustomerSearchQueryDto } from "./dto/customer-search-query.dto";
import { PaymentHistoryQueryDto } from "./dto/payment-history-query.dto";
import { CustomerSearchResponseDto } from "./dto/customer-search-response.dto";
import { PaymentHistoryResponseDto } from "./dto/payment-history-response.dto";
import { InvoiceSearchQueryDto } from "./dto/invoice-search-query.dto";
import { InvoiceSearchResponseDto } from "./dto/invoice-search-response.dto";
import { InvoiceLineItemDetailResponseDto } from "./dto/invoice-line-item-detail-response.dto";
import { DunningHistoryQueryDto } from "./dto/dunning-history-query.dto";
import { DunningHistoryResponseDto } from "./dto/dunning-history-response.dto";
import { DiscrepancySearchQueryDto } from "./dto/discrepancy-search-query.dto";
import { DiscrepancySearchResponseDto } from "./dto/discrepancy-search-response.dto";
import { UpdateDisputeStatusDto } from "./dto/update-dispute-status.dto";
import { ResolveDiscrepancyDto } from "./dto/resolve-discrepancy.dto";
import { ReconciliationExportQueryDto } from "./dto/reconciliation-export-query.dto";
import { ReconciliationExportResponseDto } from "./dto/reconciliation-export-response.dto";
import { BillingHistoryQueryDto } from "./dto/billing-history-query.dto";
import { BillingHistoryResponseDto } from "./dto/billing-history-response.dto";
import { AuditTrailSearchQueryDto } from "./dto/audit-trail-search-query.dto";
import { AuditTrailSearchResponseDto } from "./dto/audit-trail-search-response.dto";
import { BulkSubscriptionOperationDto } from "./dto/bulk-subscription-operation.dto";
import { BulkOperationResponseDto } from "./dto/bulk-operation-response.dto";
import { ApiPaginatedResponse } from "../common/decorators/api-paginated-response.decorator";

interface AdminInfoResponse {
  module: string;
  status: string;
  timestamp: string;
}

interface AdminWhoamiResponse {
  adminRole: string;
  adminUserId: string | null;
}

interface AdminEchoResponse {
  id: string;
  received: boolean;
  body: unknown;
}

@ApiTags("Admin")
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
@ApiUnauthorizedResponse({ description: "Unauthorized" })
@Controller("v1/admin")
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get("info")
  @Roles(AdminRole.Admin)
  @ApiOperation({ summary: "Get admin module info" })
  @ApiOkResponse({
    schema: {
      properties: {
        module: { type: "string" },
        status: { type: "string" },
        timestamp: { type: "string" },
      },
    },
  })
  getInfo(): AdminInfoResponse {
    return {
      module: "admin",
      status: "active",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("whoami")
  @Roles(AdminRole.Cs, AdminRole.Finance, AdminRole.Admin)
  @ApiOperation({ summary: "Get current admin identity" })
  @ApiOkResponse({
    schema: {
      properties: {
        adminRole: { type: "string" },
        adminUserId: { type: "string", nullable: true },
      },
    },
  })
  whoami(@Req() req: Record<string, unknown>): AdminWhoamiResponse {
    const adminRole = typeof req.adminRole === "string" ? req.adminRole : "";
    const adminUserId =
      typeof req.adminUserId === "string" ? req.adminUserId : null;

    return { adminRole, adminUserId };
  }

  @Post("echo")
  @Roles(AdminRole.Admin)
  @ApiOperation({ summary: "Echo request body" })
  @ApiCreatedResponse({
    schema: {
      properties: {
        id: { type: "string" },
        received: { type: "boolean" },
        body: {},
      },
    },
  })
  echo(@Body() body: unknown): AdminEchoResponse {
    return {
      id: "echo-response",
      received: true,
      body,
    };
  }

  @Get("customers/search")
  @Roles(AdminRole.Cs, AdminRole.Finance, AdminRole.Admin)
  @ApiOperation({ summary: "Search customers" })
  @ApiPaginatedResponse(CustomerSearchResponseDto)
  searchCustomers(
    @Query() query: CustomerSearchQueryDto,
  ): Promise<PaginatedResult<CustomerSearchResponseDto>> {
    return this.adminService.searchCustomers(query);
  }

  @Get("customers/:id/payments")
  @Roles(AdminRole.Cs, AdminRole.Finance, AdminRole.Admin)
  @ApiOperation({ summary: "Get customer payment history" })
  @ApiPaginatedResponse(PaymentHistoryResponseDto)
  getPaymentHistory(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: PaymentHistoryQueryDto,
  ): Promise<PaginatedResult<PaymentHistoryResponseDto>> {
    return this.adminService.getPaymentHistory(id, query);
  }

  @Get("invoices/search")
  @Roles(AdminRole.Cs, AdminRole.Finance, AdminRole.Admin)
  @ApiOperation({ summary: "Search invoices" })
  @ApiPaginatedResponse(InvoiceSearchResponseDto)
  searchInvoices(
    @Query() query: InvoiceSearchQueryDto,
  ): Promise<PaginatedResult<InvoiceSearchResponseDto>> {
    return this.adminService.searchInvoices(query);
  }

  @Get("invoices/:id/line-items")
  @Roles(AdminRole.Cs, AdminRole.Finance, AdminRole.Admin)
  @ApiOperation({ summary: "Get invoice line items" })
  @ApiPaginatedResponse(InvoiceLineItemDetailResponseDto)
  getInvoiceLineItems(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<PaginatedResult<InvoiceLineItemDetailResponseDto>> {
    return this.adminService.getInvoiceLineItems(id);
  }

  @Get("customers/:id/dunning-history")
  @Roles(AdminRole.Cs, AdminRole.Finance, AdminRole.Admin)
  @ApiOperation({ summary: "Get customer dunning history" })
  @ApiPaginatedResponse(DunningHistoryResponseDto)
  getDunningHistory(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: DunningHistoryQueryDto,
  ): Promise<PaginatedResult<DunningHistoryResponseDto>> {
    return this.adminService.getDunningHistory(id, query);
  }

  @Get("reconciliation/discrepancies")
  @Roles(AdminRole.Finance, AdminRole.Admin)
  @ApiOperation({ summary: "Search reconciliation discrepancies" })
  @ApiPaginatedResponse(DiscrepancySearchResponseDto)
  searchDiscrepancies(
    @Query() query: DiscrepancySearchQueryDto,
  ): Promise<PaginatedResult<DiscrepancySearchResponseDto>> {
    return this.adminService.searchDiscrepancies(query);
  }

  @Put("reconciliation/discrepancies/:id/status")
  @Roles(AdminRole.Finance, AdminRole.Admin)
  @ApiOperation({ summary: "Update dispute status" })
  @ApiOkResponse({ type: DiscrepancySearchResponseDto })
  updateDisputeStatus(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateDisputeStatusDto,
  ): Promise<DiscrepancySearchResponseDto> {
    return this.adminService.updateDisputeStatus(id, dto);
  }

  @Put("reconciliation/discrepancies/:id/resolve")
  @Roles(AdminRole.Finance, AdminRole.Admin)
  @ApiOperation({ summary: "Resolve a discrepancy" })
  @ApiOkResponse({ type: DiscrepancySearchResponseDto })
  resolveDiscrepancy(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ResolveDiscrepancyDto,
    @Headers("x-admin-user-id") adminUserId: string,
  ): Promise<DiscrepancySearchResponseDto> {
    return this.adminService.resolveDiscrepancy(id, dto, adminUserId);
  }

  @Get("reconciliation/export")
  @Roles(AdminRole.Finance, AdminRole.Admin)
  @ApiOperation({ summary: "Export reconciliation data" })
  @ApiOkResponse({ type: ReconciliationExportResponseDto })
  exportReconciliationData(
    @Query() query: ReconciliationExportQueryDto,
  ): Promise<ReconciliationExportResponseDto> {
    return this.adminService.exportReconciliationData(query);
  }

  @Get("customers/:id/billing-history")
  @Roles(AdminRole.Admin)
  @ApiOperation({ summary: "Get customer billing history" })
  @ApiPaginatedResponse(BillingHistoryResponseDto)
  getBillingHistory(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: BillingHistoryQueryDto,
  ): Promise<PaginatedResult<BillingHistoryResponseDto>> {
    return this.adminService.getBillingHistory(id, query);
  }

  @Get("audit-trail")
  @Roles(AdminRole.Admin)
  @ApiOperation({ summary: "Search audit trail" })
  @ApiPaginatedResponse(AuditTrailSearchResponseDto)
  searchAuditTrail(
    @Query() query: AuditTrailSearchQueryDto,
  ): Promise<PaginatedResult<AuditTrailSearchResponseDto>> {
    return this.adminService.searchAuditTrail(query);
  }

  @Post("subscriptions/bulk")
  @Roles(AdminRole.Admin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Bulk subscription state change" })
  @ApiOkResponse({ type: BulkOperationResponseDto })
  bulkSubscriptionOperation(
    @Body() dto: BulkSubscriptionOperationDto,
  ): Promise<BulkOperationResponseDto> {
    return this.adminService.bulkSubscriptionOperation(dto);
  }
}
