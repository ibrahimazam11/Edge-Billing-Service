import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { ROLES_KEY } from "../common/decorators/roles.decorator";
import { AdminRole } from "../common/enums/admin-role.enum";
import type { PaginatedResult } from "../common/dto/pagination.dto";
import type { CustomerSearchResponseDto } from "./dto/customer-search-response.dto";
import type { PaymentHistoryResponseDto } from "./dto/payment-history-response.dto";
import type { InvoiceSearchResponseDto } from "./dto/invoice-search-response.dto";
import type { InvoiceLineItemDetailResponseDto } from "./dto/invoice-line-item-detail-response.dto";
import type { DunningHistoryResponseDto } from "./dto/dunning-history-response.dto";
import type { DiscrepancySearchResponseDto } from "./dto/discrepancy-search-response.dto";
import type { ReconciliationExportResponseDto } from "./dto/reconciliation-export-response.dto";
import type { BillingHistoryResponseDto } from "./dto/billing-history-response.dto";
import type { AuditTrailSearchResponseDto } from "./dto/audit-trail-search-response.dto";
import type { BulkOperationResponseDto } from "./dto/bulk-operation-response.dto";
import { HttpStatus } from "@nestjs/common";

describe("AdminController", () => {
  let controller: AdminController;
  let adminService: jest.Mocked<AdminService>;

  beforeEach(() => {
    adminService = {
      searchCustomers: jest.fn(),
      getPaymentHistory: jest.fn(),
      searchInvoices: jest.fn(),
      getInvoiceLineItems: jest.fn(),
      getDunningHistory: jest.fn(),
      searchDiscrepancies: jest.fn(),
      updateDisputeStatus: jest.fn(),
      resolveDiscrepancy: jest.fn(),
      exportReconciliationData: jest.fn(),
      getBillingHistory: jest.fn(),
      searchAuditTrail: jest.fn(),
      bulkSubscriptionOperation: jest.fn(),
    } as unknown as jest.Mocked<AdminService>;

    controller = new AdminController(adminService);
  });

  describe("decorator metadata", () => {
    it("should have @Roles(AdminRole.Admin) on getInfo", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.getInfo,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Admin]);
    });

    it("should have @Roles(Cs, Finance, Admin) on whoami", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.whoami,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Cs, AdminRole.Finance, AdminRole.Admin]);
    });

    it("should have @Roles(Cs, Finance, Admin) on searchCustomers", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.searchCustomers,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Cs, AdminRole.Finance, AdminRole.Admin]);
    });

    it("should have @Roles(Cs, Finance, Admin) on getPaymentHistory", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.getPaymentHistory,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Cs, AdminRole.Finance, AdminRole.Admin]);
    });

    it("should have @Roles(Cs, Finance, Admin) on searchInvoices", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.searchInvoices,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Cs, AdminRole.Finance, AdminRole.Admin]);
    });

    it("should have @Roles(Cs, Finance, Admin) on getInvoiceLineItems", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.getInvoiceLineItems,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Cs, AdminRole.Finance, AdminRole.Admin]);
    });

    it("should have @Roles(Cs, Finance, Admin) on getDunningHistory", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.getDunningHistory,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Cs, AdminRole.Finance, AdminRole.Admin]);
    });

    it("should have @Roles(Finance, Admin) on searchDiscrepancies", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.searchDiscrepancies,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Finance, AdminRole.Admin]);
    });

    it("should NOT include AdminRole.Cs in searchDiscrepancies roles", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.searchDiscrepancies,
      ) as AdminRole[];
      expect(roles).not.toContain(AdminRole.Cs);
    });

    it("should have @Roles(Finance, Admin) on updateDisputeStatus", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.updateDisputeStatus,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Finance, AdminRole.Admin]);
    });

    it("should NOT include AdminRole.Cs in updateDisputeStatus roles", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.updateDisputeStatus,
      ) as AdminRole[];
      expect(roles).not.toContain(AdminRole.Cs);
    });

    it("should have @Roles(Finance, Admin) on resolveDiscrepancy", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.resolveDiscrepancy,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Finance, AdminRole.Admin]);
    });

    it("should NOT include AdminRole.Cs in resolveDiscrepancy roles", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.resolveDiscrepancy,
      ) as AdminRole[];
      expect(roles).not.toContain(AdminRole.Cs);
    });

    it("should have @Roles(Finance, Admin) on exportReconciliationData", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.exportReconciliationData,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Finance, AdminRole.Admin]);
    });

    it("should NOT include AdminRole.Cs in exportReconciliationData roles", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.exportReconciliationData,
      ) as AdminRole[];
      expect(roles).not.toContain(AdminRole.Cs);
    });

    it("should have @Roles(Admin) on getBillingHistory", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.getBillingHistory,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Admin]);
    });

    it("should NOT include AdminRole.Cs in getBillingHistory roles", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.getBillingHistory,
      ) as AdminRole[];
      expect(roles).not.toContain(AdminRole.Cs);
    });

    it("should NOT include AdminRole.Finance in getBillingHistory roles", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.getBillingHistory,
      ) as AdminRole[];
      expect(roles).not.toContain(AdminRole.Finance);
    });

    it("should have @Roles(Admin) on searchAuditTrail", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.searchAuditTrail,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Admin]);
    });

    it("should NOT include AdminRole.Cs in searchAuditTrail roles", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.searchAuditTrail,
      ) as AdminRole[];
      expect(roles).not.toContain(AdminRole.Cs);
    });

    it("should NOT include AdminRole.Finance in searchAuditTrail roles", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.searchAuditTrail,
      ) as AdminRole[];
      expect(roles).not.toContain(AdminRole.Finance);
    });
  });

  describe("getInfo()", () => {
    it("should return module metadata with admin, status, and timestamp", () => {
      const result = controller.getInfo();

      expect(result).toEqual({
        module: "admin",
        status: "active",
        timestamp: expect.any(String) as string,
      });
      expect(() => new Date(result.timestamp)).not.toThrow();
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    });
  });

  describe("whoami()", () => {
    it("should return adminRole and adminUserId from request", () => {
      const req: Record<string, unknown> = {
        adminRole: "admin",
        adminUserId: "user-1",
      };

      const result = controller.whoami(req);

      expect(result).toEqual({
        adminRole: "admin",
        adminUserId: "user-1",
      });
    });

    it("should return null for missing adminUserId", () => {
      const req: Record<string, unknown> = {
        adminRole: "cs",
      };

      const result = controller.whoami(req);

      expect(result).toEqual({
        adminRole: "cs",
        adminUserId: null,
      });
    });
  });

  describe("searchCustomers()", () => {
    it("should delegate to adminService.searchCustomers with correct query", async () => {
      const mockResult: PaginatedResult<CustomerSearchResponseDto> = {
        data: [
          {
            id: "c0000000-0000-4000-a000-000000000001",
            monolithCustomerId: "ext-123",
            name: "Test",
            email: "test@example.com",
            status: "active",
            stripeCustomerId: "cus_1",
            createdAt: "2026-01-15T10:00:00.000Z",
            updatedAt: "2026-01-15T10:00:00.000Z",
          },
        ],
        cursor: null,
        hasMore: false,
      };
      adminService.searchCustomers.mockResolvedValue(mockResult);

      const query = { name: "Test", limit: 10 };
      const result = await controller.searchCustomers(query);

      expect(result).toBe(mockResult);
      expect(adminService.searchCustomers).toHaveBeenCalledWith(query);
      expect(adminService.searchCustomers).toHaveBeenCalledTimes(1);
      // Negative assertion: other methods NOT called
      expect(adminService.getPaymentHistory).not.toHaveBeenCalled();
      expect(adminService.searchInvoices).not.toHaveBeenCalled();
      expect(adminService.getInvoiceLineItems).not.toHaveBeenCalled();
      expect(adminService.getDunningHistory).not.toHaveBeenCalled();
    });
  });

  describe("getPaymentHistory()", () => {
    it("should delegate to adminService.getPaymentHistory with correct id and query", async () => {
      const mockResult: PaginatedResult<PaymentHistoryResponseDto> = {
        data: [
          {
            id: "ch000000-0000-4000-a000-000000000001",
            invoiceId: "inv00000-0000-4000-a000-000000000001",
            amountCents: 5000,
            currency: "usd",
            status: "succeeded",
            paymentMethodType: "card",
            gatewayProvider: "stripe",
            gatewayChargeId: "pi_test_123",
            failureReason: null,
            attemptNumber: 1,
            createdAt: "2026-01-20T12:00:00.000Z",
          },
        ],
        cursor: null,
        hasMore: false,
      };
      adminService.getPaymentHistory.mockResolvedValue(mockResult);

      const id = "c0000000-0000-4000-a000-000000000001";
      const query = { dateFrom: "2026-01-01T00:00:00.000Z" };
      const result = await controller.getPaymentHistory(id, query);

      expect(result).toBe(mockResult);
      expect(adminService.getPaymentHistory).toHaveBeenCalledWith(id, query);
      expect(adminService.getPaymentHistory).toHaveBeenCalledTimes(1);
      // Negative assertion: other methods NOT called
      expect(adminService.searchCustomers).not.toHaveBeenCalled();
      expect(adminService.searchInvoices).not.toHaveBeenCalled();
      expect(adminService.getInvoiceLineItems).not.toHaveBeenCalled();
      expect(adminService.getDunningHistory).not.toHaveBeenCalled();
    });
  });

  describe("searchInvoices()", () => {
    it("should delegate to adminService.searchInvoices with correct query", async () => {
      const mockResult: PaginatedResult<InvoiceSearchResponseDto> = {
        data: [
          {
            id: "inv00000-0000-4000-a000-000000000001",
            customerId: "c0000000-0000-4000-a000-000000000001",
            subscriptionId: "sub00000-0000-4000-a000-000000000001",
            status: "finalized",
            totalAmountCents: 10000,
            currency: "usd",
            billingPeriodStart: "2026-01-01T00:00:00.000Z",
            billingPeriodEnd: "2026-02-01T00:00:00.000Z",
            dueDate: "2026-01-15T00:00:00.000Z",
            paidAt: null,
            voidedAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        cursor: null,
        hasMore: false,
      };
      adminService.searchInvoices.mockResolvedValue(mockResult);

      const query = { status: "finalized", limit: 10 };
      const result = await controller.searchInvoices(query);

      expect(result).toBe(mockResult);
      expect(adminService.searchInvoices).toHaveBeenCalledWith(query);
      expect(adminService.searchInvoices).toHaveBeenCalledTimes(1);
      // Negative assertion: other methods NOT called
      expect(adminService.searchCustomers).not.toHaveBeenCalled();
      expect(adminService.getPaymentHistory).not.toHaveBeenCalled();
      expect(adminService.getInvoiceLineItems).not.toHaveBeenCalled();
      expect(adminService.getDunningHistory).not.toHaveBeenCalled();
    });
  });

  describe("getInvoiceLineItems()", () => {
    it("should delegate to adminService.getInvoiceLineItems with correct id", async () => {
      const mockResult: PaginatedResult<InvoiceLineItemDetailResponseDto> = {
        data: [
          {
            id: "li000000-0000-4000-a000-000000000001",
            invoiceId: "inv00000-0000-4000-a000-000000000001",
            type: "subscription_fee",
            description: "Monthly subscription",
            amountCents: 10000,
            quantity: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        cursor: null,
        hasMore: false,
      };
      adminService.getInvoiceLineItems.mockResolvedValue(mockResult);

      const id = "inv00000-0000-4000-a000-000000000001";
      const result = await controller.getInvoiceLineItems(id);

      expect(result).toBe(mockResult);
      expect(adminService.getInvoiceLineItems).toHaveBeenCalledWith(id);
      expect(adminService.getInvoiceLineItems).toHaveBeenCalledTimes(1);
      // Negative assertion: other methods NOT called
      expect(adminService.searchCustomers).not.toHaveBeenCalled();
      expect(adminService.getPaymentHistory).not.toHaveBeenCalled();
      expect(adminService.searchInvoices).not.toHaveBeenCalled();
      expect(adminService.getDunningHistory).not.toHaveBeenCalled();
    });
  });

  describe("getDunningHistory()", () => {
    it("should delegate to adminService.getDunningHistory with correct id and query", async () => {
      const mockResult: PaginatedResult<DunningHistoryResponseDto> = {
        data: [
          {
            id: "da000000-0000-4000-a000-000000000001",
            invoiceId: "inv00000-0000-4000-a000-000000000001",
            chargeId: "ch000000-0000-4000-a000-000000000001",
            paymentMethodId: "pm000000-0000-4000-a000-000000000001",
            attemptNumber: 1,
            scheduledDate: "2026-01-20T00:00:00.000Z",
            executedAt: "2026-01-20T12:00:00.000Z",
            status: "failed",
            failureReason: "insufficient_funds",
            paymentMethodType: "card",
            gatewayProvider: "stripe",
            createdAt: "2026-01-20T12:00:00.000Z",
          },
        ],
        cursor: null,
        hasMore: false,
      };
      adminService.getDunningHistory.mockResolvedValue(mockResult);

      const id = "c0000000-0000-4000-a000-000000000001";
      const query = { dateFrom: "2026-01-01T00:00:00.000Z" };
      const result = await controller.getDunningHistory(id, query);

      expect(result).toBe(mockResult);
      expect(adminService.getDunningHistory).toHaveBeenCalledWith(id, query);
      expect(adminService.getDunningHistory).toHaveBeenCalledTimes(1);
      // Negative assertion: other methods NOT called
      expect(adminService.searchCustomers).not.toHaveBeenCalled();
      expect(adminService.getPaymentHistory).not.toHaveBeenCalled();
      expect(adminService.searchInvoices).not.toHaveBeenCalled();
      expect(adminService.getInvoiceLineItems).not.toHaveBeenCalled();
    });
  });

  describe("searchDiscrepancies()", () => {
    it("should delegate to adminService.searchDiscrepancies with correct query", async () => {
      const mockResult: PaginatedResult<DiscrepancySearchResponseDto> = {
        data: [
          {
            id: "rd000000-0000-4000-a000-000000000001",
            reconciliationRunId: "rr000000-0000-4000-a000-000000000001",
            type: "amount_mismatch",
            internalReferenceId: "ch000000-0000-4000-a000-000000000001",
            stripeTransactionId: "pi_test_123",
            expectedAmountCents: 10000,
            actualAmountCents: 9500,
            differenceCents: 500,
            disputeStatus: "open",
            resolvedBy: null,
            resolutionNotes: null,
            resolvedAt: null,
            createdAt: "2026-01-15T10:00:00.000Z",
            periodStart: "2026-01-01T00:00:00.000Z",
            periodEnd: "2026-02-01T00:00:00.000Z",
          },
        ],
        cursor: null,
        hasMore: false,
      };
      adminService.searchDiscrepancies.mockResolvedValue(mockResult);

      const query = { disputeStatus: "open", limit: 10 };
      const result = await controller.searchDiscrepancies(query);

      expect(result).toBe(mockResult);
      expect(adminService.searchDiscrepancies).toHaveBeenCalledWith(query);
      expect(adminService.searchDiscrepancies).toHaveBeenCalledTimes(1);
      // Negative assertion: other methods NOT called
      expect(adminService.searchCustomers).not.toHaveBeenCalled();
      expect(adminService.getPaymentHistory).not.toHaveBeenCalled();
      expect(adminService.searchInvoices).not.toHaveBeenCalled();
      expect(adminService.getInvoiceLineItems).not.toHaveBeenCalled();
      expect(adminService.getDunningHistory).not.toHaveBeenCalled();
      expect(adminService.updateDisputeStatus).not.toHaveBeenCalled();
    });
  });

  describe("updateDisputeStatus()", () => {
    it("should delegate to adminService.updateDisputeStatus with correct id and body", async () => {
      const mockResult: DiscrepancySearchResponseDto = {
        id: "rd000000-0000-4000-a000-000000000001",
        reconciliationRunId: "rr000000-0000-4000-a000-000000000001",
        type: "amount_mismatch",
        internalReferenceId: null,
        stripeTransactionId: null,
        expectedAmountCents: 10000,
        actualAmountCents: 9500,
        differenceCents: 500,
        disputeStatus: "investigating",
        resolvedBy: null,
        resolutionNotes: null,
        resolvedAt: null,
        createdAt: "2026-01-15T10:00:00.000Z",
        periodStart: null,
        periodEnd: null,
      };
      adminService.updateDisputeStatus.mockResolvedValue(mockResult);

      const id = "rd000000-0000-4000-a000-000000000001";
      const dto = { status: "investigating" };
      const result = await controller.updateDisputeStatus(id, dto);

      expect(result).toBe(mockResult);
      expect(adminService.updateDisputeStatus).toHaveBeenCalledWith(id, dto);
      expect(adminService.updateDisputeStatus).toHaveBeenCalledTimes(1);
      // Negative assertion: other methods NOT called
      expect(adminService.searchCustomers).not.toHaveBeenCalled();
      expect(adminService.getPaymentHistory).not.toHaveBeenCalled();
      expect(adminService.searchInvoices).not.toHaveBeenCalled();
      expect(adminService.getInvoiceLineItems).not.toHaveBeenCalled();
      expect(adminService.getDunningHistory).not.toHaveBeenCalled();
      expect(adminService.searchDiscrepancies).not.toHaveBeenCalled();
    });
  });

  describe("resolveDiscrepancy()", () => {
    it("should delegate to adminService.resolveDiscrepancy with id, dto, and adminUserId", async () => {
      const mockResult: DiscrepancySearchResponseDto = {
        id: "rd000000-0000-4000-a000-000000000001",
        reconciliationRunId: "rr000000-0000-4000-a000-000000000001",
        type: "amount_mismatch",
        internalReferenceId: null,
        stripeTransactionId: null,
        expectedAmountCents: 10000,
        actualAmountCents: 9500,
        differenceCents: 500,
        disputeStatus: "resolved",
        resolvedBy: "admin-user-42",
        resolutionNotes: "Confirmed with Stripe",
        resolvedAt: "2026-01-20T15:00:00.000Z",
        createdAt: "2026-01-15T10:00:00.000Z",
        periodStart: null,
        periodEnd: null,
      };
      adminService.resolveDiscrepancy.mockResolvedValue(mockResult);

      const id = "rd000000-0000-4000-a000-000000000001";
      const dto = { resolutionNotes: "Confirmed with Stripe" };
      const adminUserId = "admin-user-42";
      const result = await controller.resolveDiscrepancy(id, dto, adminUserId);

      expect(result).toBe(mockResult);
      expect(adminService.resolveDiscrepancy).toHaveBeenCalledWith(
        id,
        dto,
        adminUserId,
      );
      expect(adminService.resolveDiscrepancy).toHaveBeenCalledTimes(1);
      // Negative assertion: other methods NOT called
      expect(adminService.searchCustomers).not.toHaveBeenCalled();
      expect(adminService.getPaymentHistory).not.toHaveBeenCalled();
      expect(adminService.searchInvoices).not.toHaveBeenCalled();
      expect(adminService.getInvoiceLineItems).not.toHaveBeenCalled();
      expect(adminService.getDunningHistory).not.toHaveBeenCalled();
      expect(adminService.searchDiscrepancies).not.toHaveBeenCalled();
      expect(adminService.updateDisputeStatus).not.toHaveBeenCalled();
    });
  });

  describe("exportReconciliationData()", () => {
    it("should delegate to adminService.exportReconciliationData with query", async () => {
      const mockResult: ReconciliationExportResponseDto = {
        exportDate: "2026-01-20T15:00:00.000Z",
        dateRange: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-02-01T00:00:00.000Z",
        },
        summary: {
          totalDiscrepancies: 0,
          byStatus: { open: 0, investigating: 0, resolved: 0, dismissed: 0 },
          totalDifferenceCents: 0,
        },
        discrepancies: [],
      };
      adminService.exportReconciliationData.mockResolvedValue(mockResult);

      const query = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await controller.exportReconciliationData(query);

      expect(result).toBe(mockResult);
      expect(adminService.exportReconciliationData).toHaveBeenCalledWith(query);
      expect(adminService.exportReconciliationData).toHaveBeenCalledTimes(1);
      // Negative assertion: other methods NOT called
      expect(adminService.searchCustomers).not.toHaveBeenCalled();
      expect(adminService.getPaymentHistory).not.toHaveBeenCalled();
      expect(adminService.searchInvoices).not.toHaveBeenCalled();
      expect(adminService.getInvoiceLineItems).not.toHaveBeenCalled();
      expect(adminService.getDunningHistory).not.toHaveBeenCalled();
      expect(adminService.searchDiscrepancies).not.toHaveBeenCalled();
      expect(adminService.updateDisputeStatus).not.toHaveBeenCalled();
      expect(adminService.resolveDiscrepancy).not.toHaveBeenCalled();
      expect(adminService.getBillingHistory).not.toHaveBeenCalled();
      expect(adminService.searchAuditTrail).not.toHaveBeenCalled();
    });
  });

  describe("getBillingHistory()", () => {
    it("should delegate to adminService.getBillingHistory with correct id and query", async () => {
      const mockResult: PaginatedResult<BillingHistoryResponseDto> = {
        data: [
          {
            id: "inv00000-0000-4000-a000-000000000001",
            type: "invoice",
            referenceId: "inv00000-0000-4000-a000-000000000001",
            description: "Invoice for 2026-01-01 - 2026-02-01",
            amountCents: 10000,
            currency: "usd",
            status: "finalized",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        cursor: null,
        hasMore: false,
      };
      adminService.getBillingHistory.mockResolvedValue(mockResult);

      const id = "c0000000-0000-4000-a000-000000000001";
      const query = { type: "invoice" as const, limit: 10 };
      const result = await controller.getBillingHistory(id, query);

      expect(result).toBe(mockResult);
      expect(adminService.getBillingHistory).toHaveBeenCalledWith(id, query);
      expect(adminService.getBillingHistory).toHaveBeenCalledTimes(1);
      // Negative assertion: other methods NOT called
      expect(adminService.searchCustomers).not.toHaveBeenCalled();
      expect(adminService.getPaymentHistory).not.toHaveBeenCalled();
      expect(adminService.searchInvoices).not.toHaveBeenCalled();
      expect(adminService.getInvoiceLineItems).not.toHaveBeenCalled();
      expect(adminService.getDunningHistory).not.toHaveBeenCalled();
      expect(adminService.searchDiscrepancies).not.toHaveBeenCalled();
      expect(adminService.updateDisputeStatus).not.toHaveBeenCalled();
      expect(adminService.resolveDiscrepancy).not.toHaveBeenCalled();
      expect(adminService.exportReconciliationData).not.toHaveBeenCalled();
      expect(adminService.searchAuditTrail).not.toHaveBeenCalled();
    });
  });

  describe("searchAuditTrail()", () => {
    it("should delegate to adminService.searchAuditTrail with correct query", async () => {
      const mockResult: PaginatedResult<AuditTrailSearchResponseDto> = {
        data: [
          {
            id: "at000000-0000-4000-a000-000000000001",
            adminUserId: "admin-user-1",
            action: "PUT /v1/admin/reconciliation/discrepancies/123/resolve",
            entityType: "reconciliation_discrepancy",
            entityId: "rd000000-0000-4000-a000-000000000001",
            details: { resolutionNotes: "Confirmed" },
            createdAt: "2026-01-20T15:00:00.000Z",
          },
        ],
        cursor: null,
        hasMore: false,
      };
      adminService.searchAuditTrail.mockResolvedValue(mockResult);

      const query = { entityType: "reconciliation_discrepancy", limit: 10 };
      const result = await controller.searchAuditTrail(query);

      expect(result).toBe(mockResult);
      expect(adminService.searchAuditTrail).toHaveBeenCalledWith(query);
      expect(adminService.searchAuditTrail).toHaveBeenCalledTimes(1);
      // Negative assertion: other methods NOT called
      expect(adminService.searchCustomers).not.toHaveBeenCalled();
      expect(adminService.getPaymentHistory).not.toHaveBeenCalled();
      expect(adminService.searchInvoices).not.toHaveBeenCalled();
      expect(adminService.getInvoiceLineItems).not.toHaveBeenCalled();
      expect(adminService.getDunningHistory).not.toHaveBeenCalled();
      expect(adminService.searchDiscrepancies).not.toHaveBeenCalled();
      expect(adminService.updateDisputeStatus).not.toHaveBeenCalled();
      expect(adminService.resolveDiscrepancy).not.toHaveBeenCalled();
      expect(adminService.exportReconciliationData).not.toHaveBeenCalled();
      expect(adminService.getBillingHistory).not.toHaveBeenCalled();
    });
  });

  describe("bulkSubscriptionOperation()", () => {
    it("should delegate to adminService.bulkSubscriptionOperation with correct DTO", async () => {
      const mockResult: BulkOperationResponseDto = {
        successCount: 2,
        failureCount: 0,
        results: [
          {
            subscriptionId: "s0000000-0000-4000-a000-000000000001",
            success: true,
          },
          {
            subscriptionId: "s0000000-0000-4000-a000-000000000002",
            success: true,
          },
        ],
      };
      adminService.bulkSubscriptionOperation.mockResolvedValue(mockResult);

      const dto = {
        action: "pause" as const,
        subscriptionIds: [
          "s0000000-0000-4000-a000-000000000001",
          "s0000000-0000-4000-a000-000000000002",
        ],
      };
      const result = await controller.bulkSubscriptionOperation(dto);

      expect(result).toBe(mockResult);
      expect(adminService.bulkSubscriptionOperation).toHaveBeenCalledWith(dto);
      expect(adminService.bulkSubscriptionOperation).toHaveBeenCalledTimes(1);
      // Negative assertion: other methods NOT called
      expect(adminService.searchCustomers).not.toHaveBeenCalled();
      expect(adminService.getPaymentHistory).not.toHaveBeenCalled();
      expect(adminService.searchInvoices).not.toHaveBeenCalled();
      expect(adminService.getInvoiceLineItems).not.toHaveBeenCalled();
      expect(adminService.getDunningHistory).not.toHaveBeenCalled();
      expect(adminService.searchDiscrepancies).not.toHaveBeenCalled();
      expect(adminService.updateDisputeStatus).not.toHaveBeenCalled();
      expect(adminService.resolveDiscrepancy).not.toHaveBeenCalled();
      expect(adminService.exportReconciliationData).not.toHaveBeenCalled();
      expect(adminService.getBillingHistory).not.toHaveBeenCalled();
      expect(adminService.searchAuditTrail).not.toHaveBeenCalled();
    });

    it("should have @Roles(Admin) on bulkSubscriptionOperation", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.bulkSubscriptionOperation,
      ) as AdminRole[];
      expect(roles).toEqual([AdminRole.Admin]);
    });

    it("should NOT include AdminRole.Cs in bulkSubscriptionOperation roles", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.bulkSubscriptionOperation,
      ) as AdminRole[];
      expect(roles).not.toContain(AdminRole.Cs);
    });

    it("should NOT include AdminRole.Finance in bulkSubscriptionOperation roles", () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.bulkSubscriptionOperation,
      ) as AdminRole[];
      expect(roles).not.toContain(AdminRole.Finance);
    });

    it("should have @HttpCode(200) decorator overriding POST default 201", () => {
      const httpCode = Reflect.getMetadata(
        "__httpCode__",
        AdminController.prototype.bulkSubscriptionOperation,
      ) as number;
      expect(httpCode).toBe(HttpStatus.OK);
    });
  });
});
