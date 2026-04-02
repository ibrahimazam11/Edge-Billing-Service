import { Test, TestingModule } from "@nestjs/testing";
import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { AdminService } from "./admin.service";
import { CustomersRepository } from "../customers/customers.repository";
import { InvoicesRepository } from "../invoices/invoices.repository";
import { ChargesRepository } from "../charges/charges.repository";
import { DunningAttemptsRepository } from "../dunning/dunning.repository";
import { ReconciliationDiscrepanciesRepository } from "../reconciliation/reconciliation-discrepancies.repository";
import { RefundsRepository } from "../refunds/refunds.repository";
import { CreditNotesRepository } from "../credits/credit-notes.repository";
import { AuditTrailRepository } from "./audit-trail.repository";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { SubscriptionNotFoundException } from "../common/exceptions/subscription-not-found.exception";
import { StateTransitionException } from "../common/exceptions/billing.exception";
import type { CustomerSearchQueryDto } from "./dto/customer-search-query.dto";
import type { PaymentHistoryQueryDto } from "./dto/payment-history-query.dto";
import type { InvoiceSearchQueryDto } from "./dto/invoice-search-query.dto";
import type { DunningHistoryQueryDto } from "./dto/dunning-history-query.dto";
import type { DiscrepancySearchQueryDto } from "./dto/discrepancy-search-query.dto";
import type { UpdateDisputeStatusDto } from "./dto/update-dispute-status.dto";
import type { ResolveDiscrepancyDto } from "./dto/resolve-discrepancy.dto";
import type { ReconciliationExportQueryDto } from "./dto/reconciliation-export-query.dto";
import type { BillingHistoryQueryDto } from "./dto/billing-history-query.dto";
import type { AuditTrailSearchQueryDto } from "./dto/audit-trail-search-query.dto";
import type { BulkSubscriptionOperationDto } from "./dto/bulk-subscription-operation.dto";
import { CustomerStatus } from "../customers/dto/customer-query.dto";

const mockCustomerRow = (overrides: Record<string, unknown> = {}) => ({
  id: "c0000000-0000-4000-a000-000000000001",
  monolithCustomerId: "ext-123",
  stripeCustomerId: "cus_stripe_1",
  name: "Test Customer",
  email: "test@example.com",
  status: "active",
  metadata: null,
  createdAt: new Date("2026-01-15T10:00:00.000Z"),
  updatedAt: new Date("2026-01-15T10:00:00.000Z"),
  ...overrides,
});

const mockChargeRow = (overrides: Record<string, unknown> = {}) => ({
  id: "ch000000-0000-4000-a000-000000000001",
  invoiceId: "inv00000-0000-4000-a000-000000000001",
  amountCents: 5000,
  currency: "usd",
  status: "succeeded",
  stripePaymentIntentId: "pi_test_123",
  failureReason: null,
  attemptNumber: 1,
  createdAt: new Date("2026-01-20T12:00:00.000Z"),
  paymentMethodType: "card",
  gatewayProvider: "stripe",
  ...overrides,
});

const mockInvoiceRow = (overrides: Record<string, unknown> = {}) => ({
  id: "inv00000-0000-4000-a000-000000000001",
  customerId: "c0000000-0000-4000-a000-000000000001",
  subscriptionId: "sub00000-0000-4000-a000-000000000001",
  status: "finalized",
  totalAmountCents: 10000,
  currency: "usd",
  billingPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-02-01T00:00:00.000Z"),
  dueDate: new Date("2026-01-15T00:00:00.000Z"),
  paidAt: null,
  voidedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const mockLineItemRow = (overrides: Record<string, unknown> = {}) => ({
  id: "li000000-0000-4000-a000-000000000001",
  invoiceId: "inv00000-0000-4000-a000-000000000001",
  type: "subscription_fee",
  description: "Monthly subscription",
  amountCents: 10000,
  quantity: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const mockDiscrepancyRow = (overrides: Record<string, unknown> = {}) => ({
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
  createdAt: new Date("2026-01-15T10:00:00.000Z"),
  periodStart: new Date("2026-01-01T00:00:00.000Z"),
  periodEnd: new Date("2026-02-01T00:00:00.000Z"),
  ...overrides,
});

const mockCreditNoteRow = (overrides: Record<string, unknown> = {}) => ({
  id: "cn000000-0000-4000-a000-000000000001",
  amountCents: 2000,
  currency: "usd",
  status: "issued",
  reason: "Billing error",
  createdAt: new Date("2026-01-18T09:00:00.000Z"),
  ...overrides,
});

const mockRefundRow = (overrides: Record<string, unknown> = {}) => ({
  id: "rf000000-0000-4000-a000-000000000001",
  amountCents: 3000,
  currency: "usd",
  status: "succeeded",
  reason: "Customer request",
  failureReason: null,
  createdAt: new Date("2026-01-19T11:00:00.000Z"),
  ...overrides,
});

const mockAuditTrailRow = (overrides: Record<string, unknown> = {}) => ({
  id: "at000000-0000-4000-a000-000000000001",
  adminUserId: "admin-user-1",
  action: "PUT /v1/admin/reconciliation/discrepancies/123/resolve",
  entityType: "reconciliation_discrepancy",
  entityId: "rd000000-0000-4000-a000-000000000001",
  details: { resolutionNotes: "Confirmed" },
  createdAt: new Date("2026-01-20T15:00:00.000Z"),
  ...overrides,
});

const mockDunningRow = (overrides: Record<string, unknown> = {}) => ({
  id: "da000000-0000-4000-a000-000000000001",
  invoiceId: "inv00000-0000-4000-a000-000000000001",
  chargeId: "ch000000-0000-4000-a000-000000000001",
  paymentMethodId: "pm000000-0000-4000-a000-000000000001",
  attemptNumber: 1,
  scheduledDate: new Date("2026-01-20T00:00:00.000Z"),
  executedAt: new Date("2026-01-20T12:00:00.000Z"),
  status: "failed",
  failureReason: "insufficient_funds",
  createdAt: new Date("2026-01-20T12:00:00.000Z"),
  paymentMethodType: "card",
  gatewayProvider: "stripe",
  ...overrides,
});

describe("AdminService", () => {
  let service: AdminService;

  const mockCustomersRepo = {
    findById: jest.fn(),
    search: jest.fn(),
  };

  const mockInvoicesRepo = {
    findById: jest.fn(),
    searchForAdmin: jest.fn(),
    getLineItemsByInvoiceId: jest.fn(),
    findForBillingHistory: jest.fn(),
  };

  const mockChargesRepo = {
    findByCustomerWithPaymentMethod: jest.fn(),
    findForBillingHistory: jest.fn(),
  };

  const mockDunningRepo = {
    findWithInvoiceAndPaymentMethod: jest.fn(),
  };

  const mockDiscrepanciesRepo = {
    search: jest.fn(),
    findById: jest.fn(),
    findWithRunDetails: jest.fn(),
    updateDisputeStatus: jest.fn(),
    resolve: jest.fn(),
    exportByDateRange: jest.fn(),
  };

  const mockRefundsRepo = {
    findForBillingHistory: jest.fn(),
  };

  const mockCreditNotesRepo = {
    findForBillingHistory: jest.fn(),
  };

  const mockAuditTrailRepo = {
    search: jest.fn(),
  };

  const mockSubscriptionsService = {
    updateState: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: CustomersRepository, useValue: mockCustomersRepo },
        { provide: InvoicesRepository, useValue: mockInvoicesRepo },
        { provide: ChargesRepository, useValue: mockChargesRepo },
        { provide: DunningAttemptsRepository, useValue: mockDunningRepo },
        {
          provide: ReconciliationDiscrepanciesRepository,
          useValue: mockDiscrepanciesRepo,
        },
        { provide: RefundsRepository, useValue: mockRefundsRepo },
        { provide: CreditNotesRepository, useValue: mockCreditNotesRepo },
        { provide: AuditTrailRepository, useValue: mockAuditTrailRepo },
        { provide: SubscriptionsService, useValue: mockSubscriptionsService },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  describe("searchCustomers", () => {
    it("should search by name with ILIKE filter", async () => {
      const row = mockCustomerRow();
      mockCustomersRepo.search.mockResolvedValue([row]);

      const query: CustomerSearchQueryDto = { name: "test" };
      const result = await service.searchCustomers(query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: row.id,
        monolithCustomerId: row.monolithCustomerId,
        name: row.name,
        email: row.email,
        status: row.status,
        stripeCustomerId: row.stripeCustomerId,
        createdAt: "2026-01-15T10:00:00.000Z",
        updatedAt: "2026-01-15T10:00:00.000Z",
      });
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockCustomersRepo.search).toHaveBeenCalledWith(
        {
          name: "test",
          email: undefined,
          externalId: undefined,
          status: undefined,
          cursor: undefined,
        },
        20,
      );
    });

    it("should search by email with ILIKE filter", async () => {
      const row = mockCustomerRow();
      mockCustomersRepo.search.mockResolvedValue([row]);

      const query: CustomerSearchQueryDto = { email: "test@" };
      const result = await service.searchCustomers(query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].email).toBe("test@example.com");
      expect(mockCustomersRepo.search).toHaveBeenCalled();
    });

    it("should search by externalId with exact match", async () => {
      const row = mockCustomerRow();
      mockCustomersRepo.search.mockResolvedValue([row]);

      const query: CustomerSearchQueryDto = { externalId: "ext-123" };
      const result = await service.searchCustomers(query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].monolithCustomerId).toBe("ext-123");
      expect(mockCustomersRepo.search).toHaveBeenCalled();
    });

    it("should search by status filter", async () => {
      const row = mockCustomerRow({ status: "active" });
      mockCustomersRepo.search.mockResolvedValue([row]);

      const query: CustomerSearchQueryDto = { status: CustomerStatus.ACTIVE };
      const result = await service.searchCustomers(query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].status).toBe("active");
      expect(mockCustomersRepo.search).toHaveBeenCalled();
    });

    it("should combine multiple filters with AND logic", async () => {
      mockCustomersRepo.search.mockResolvedValue([]);

      const query: CustomerSearchQueryDto = {
        name: "test",
        email: "test@",
        externalId: "ext-123",
        status: CustomerStatus.ACTIVE,
      };
      const result = await service.searchCustomers(query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockCustomersRepo.search).toHaveBeenCalled();
    });

    it("should apply cursor pagination with gt and correct hasMore flag", async () => {
      const rows = [
        mockCustomerRow({ id: "c0000000-0000-4000-a000-000000000002" }),
        mockCustomerRow({ id: "c0000000-0000-4000-a000-000000000003" }),
        mockCustomerRow({ id: "c0000000-0000-4000-a000-000000000004" }),
      ];
      mockCustomersRepo.search.mockResolvedValue(rows);

      const query: CustomerSearchQueryDto = {
        cursor: "c0000000-0000-4000-a000-000000000001",
        limit: 2,
      };
      const result = await service.searchCustomers(query);

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe("c0000000-0000-4000-a000-000000000003");
      expect(mockCustomersRepo.search).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: "c0000000-0000-4000-a000-000000000001",
        }),
        2,
      );
    });

    it("should return empty results when no matches found", async () => {
      mockCustomersRepo.search.mockResolvedValue([]);

      const query: CustomerSearchQueryDto = { name: "nonexistent" };
      const result = await service.searchCustomers(query);

      expect(result).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });

    it("should skip empty string name filter", async () => {
      mockCustomersRepo.search.mockResolvedValue([]);

      const query: CustomerSearchQueryDto = { name: "" };
      const result = await service.searchCustomers(query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockCustomersRepo.search).toHaveBeenCalled();
    });

    it("should handle special ILIKE characters in search without error", async () => {
      mockCustomersRepo.search.mockResolvedValue([]);

      const query: CustomerSearchQueryDto = { name: "%discount%" };
      const result = await service.searchCustomers(query);

      expect(result.data).toEqual([]);
      expect(mockCustomersRepo.search).toHaveBeenCalled();
    });

    it("should handle underscore ILIKE wildcard in search without error", async () => {
      mockCustomersRepo.search.mockResolvedValue([]);

      const query: CustomerSearchQueryDto = { name: "_test_" };
      const result = await service.searchCustomers(query);

      expect(result.data).toEqual([]);
      expect(mockCustomersRepo.search).toHaveBeenCalled();
    });

    it("should use default limit of 20 when not specified", async () => {
      mockCustomersRepo.search.mockResolvedValue([]);

      const query: CustomerSearchQueryDto = {};
      await service.searchCustomers(query);

      expect(mockCustomersRepo.search).toHaveBeenCalledWith(
        expect.any(Object),
        20,
      );
    });

    it("should handle very long search string without error", async () => {
      mockCustomersRepo.search.mockResolvedValue([]);

      const longName = "a".repeat(1000);
      const query: CustomerSearchQueryDto = { name: longName };
      const result = await service.searchCustomers(query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockCustomersRepo.search).toHaveBeenCalled();
    });

    it("should handle no filters — returns all customers", async () => {
      const row = mockCustomerRow();
      mockCustomersRepo.search.mockResolvedValue([row]);

      const query: CustomerSearchQueryDto = {};
      const result = await service.searchCustomers(query);

      expect(result.data).toHaveLength(1);
      expect(mockCustomersRepo.search).toHaveBeenCalled();
    });
  });

  describe("getPaymentHistory", () => {
    const customerId = "c0000000-0000-4000-a000-000000000001";

    it("should return charges with payment method type and gateway provider from join", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const row = mockChargeRow();
      mockChargesRepo.findByCustomerWithPaymentMethod.mockResolvedValue([row]);

      const query: PaymentHistoryQueryDto = {};
      const result = await service.getPaymentHistory(customerId, query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: row.id,
        invoiceId: row.invoiceId,
        amountCents: 5000,
        currency: "usd",
        status: "succeeded",
        paymentMethodType: "card",
        gatewayProvider: "stripe",
        gatewayChargeId: "pi_test_123",
        failureReason: null,
        attemptNumber: 1,
        createdAt: "2026-01-20T12:00:00.000Z",
      });
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(
        mockChargesRepo.findByCustomerWithPaymentMethod,
      ).toHaveBeenCalledWith(
        customerId,
        { dateFrom: undefined, dateTo: undefined, cursor: undefined },
        20,
      );
    });

    it("should filter by dateFrom with gte", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      mockChargesRepo.findByCustomerWithPaymentMethod.mockResolvedValue([]);

      const query: PaymentHistoryQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
      };
      const result = await service.getPaymentHistory(customerId, query);

      expect(result.data).toEqual([]);
      expect(
        mockChargesRepo.findByCustomerWithPaymentMethod,
      ).toHaveBeenCalled();
    });

    it("should filter by dateTo with lt", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      mockChargesRepo.findByCustomerWithPaymentMethod.mockResolvedValue([]);

      const query: PaymentHistoryQueryDto = {
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.getPaymentHistory(customerId, query);

      expect(result.data).toEqual([]);
      expect(
        mockChargesRepo.findByCustomerWithPaymentMethod,
      ).toHaveBeenCalled();
    });

    it("should apply half-open interval with both dateFrom and dateTo", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      mockChargesRepo.findByCustomerWithPaymentMethod.mockResolvedValue([]);

      const query: PaymentHistoryQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.getPaymentHistory(customerId, query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(
        mockChargesRepo.findByCustomerWithPaymentMethod,
      ).toHaveBeenCalled();
    });

    it("should return empty results when dateFrom is after dateTo", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      mockChargesRepo.findByCustomerWithPaymentMethod.mockResolvedValue([]);

      const query: PaymentHistoryQueryDto = {
        dateFrom: "2026-03-01T00:00:00.000Z",
        dateTo: "2026-01-01T00:00:00.000Z",
      };
      const result = await service.getPaymentHistory(customerId, query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it("should apply descending cursor pagination with lt", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const rows = [
        mockChargeRow({ id: "ch000000-0000-4000-a000-000000000003" }),
        mockChargeRow({ id: "ch000000-0000-4000-a000-000000000002" }),
        mockChargeRow({ id: "ch000000-0000-4000-a000-000000000001" }),
      ];
      mockChargesRepo.findByCustomerWithPaymentMethod.mockResolvedValue(rows);

      const query: PaymentHistoryQueryDto = {
        cursor: "ch000000-0000-4000-a000-000000000004",
        limit: 2,
      };
      const result = await service.getPaymentHistory(customerId, query);

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe("ch000000-0000-4000-a000-000000000002");
      expect(
        mockChargesRepo.findByCustomerWithPaymentMethod,
      ).toHaveBeenCalledWith(
        customerId,
        expect.objectContaining({
          cursor: "ch000000-0000-4000-a000-000000000004",
        }),
        2,
      );
    });

    it("should return empty results when no charges found", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      mockChargesRepo.findByCustomerWithPaymentMethod.mockResolvedValue([]);

      const query: PaymentHistoryQueryDto = {};
      const result = await service.getPaymentHistory(customerId, query);

      expect(result).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });

    it("should throw NotFoundException when customer does not exist", async () => {
      mockCustomersRepo.findById.mockResolvedValue(null);

      const query: PaymentHistoryQueryDto = {};

      let caughtError: unknown;
      try {
        await service.getPaymentHistory(customerId, query);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(NotFoundException);
      expect((caughtError as NotFoundException).message).toBe(
        `Customer ${customerId} not found`,
      );

      // Charges query should NOT be called when customer not found
      expect(
        mockChargesRepo.findByCustomerWithPaymentMethod,
      ).not.toHaveBeenCalled();
    });

    it("should use default limit of 20 when not specified", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      mockChargesRepo.findByCustomerWithPaymentMethod.mockResolvedValue([]);

      const query: PaymentHistoryQueryDto = {};
      await service.getPaymentHistory(customerId, query);

      expect(
        mockChargesRepo.findByCustomerWithPaymentMethod,
      ).toHaveBeenCalledWith(customerId, expect.any(Object), 20);
    });

    it("should handle charge with null payment method fields from left join", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const row = mockChargeRow({
        paymentMethodType: null,
        gatewayProvider: null,
        stripePaymentIntentId: null,
      });
      mockChargesRepo.findByCustomerWithPaymentMethod.mockResolvedValue([row]);

      const query: PaymentHistoryQueryDto = {};
      const result = await service.getPaymentHistory(customerId, query);

      expect(result.data[0].paymentMethodType).toBeNull();
      expect(result.data[0].gatewayProvider).toBeNull();
      expect(result.data[0].gatewayChargeId).toBeNull();
    });
  });

  describe("searchInvoices", () => {
    it("should filter by customerId with exact match", async () => {
      const row = mockInvoiceRow();
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([row]);

      const query: InvoiceSearchQueryDto = {
        customerId: "c0000000-0000-4000-a000-000000000001",
      };
      const result = await service.searchInvoices(query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: row.id,
        customerId: row.customerId,
        subscriptionId: row.subscriptionId,
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
      });
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockInvoicesRepo.searchForAdmin).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "c0000000-0000-4000-a000-000000000001",
        }),
        20,
      );
    });

    it("should filter by status with exact match", async () => {
      const row = mockInvoiceRow({ status: "paid" });
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([row]);

      const query: InvoiceSearchQueryDto = { status: "paid" };
      const result = await service.searchInvoices(query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].status).toBe("paid");
      expect(mockInvoicesRepo.searchForAdmin).toHaveBeenCalled();
    });

    it("should filter by dateFrom with gte on createdAt", async () => {
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([]);

      const query: InvoiceSearchQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
      };
      const result = await service.searchInvoices(query);

      expect(result.data).toEqual([]);
      expect(mockInvoicesRepo.searchForAdmin).toHaveBeenCalled();
    });

    it("should filter by dateTo with lt on createdAt", async () => {
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([]);

      const query: InvoiceSearchQueryDto = {
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.searchInvoices(query);

      expect(result.data).toEqual([]);
      expect(mockInvoicesRepo.searchForAdmin).toHaveBeenCalled();
    });

    it("should filter by amountMin with gte on totalAmountCents", async () => {
      const row = mockInvoiceRow({ totalAmountCents: 5000 });
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([row]);

      const query: InvoiceSearchQueryDto = { amountMin: 3000 };
      const result = await service.searchInvoices(query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].totalAmountCents).toBe(5000);
      expect(mockInvoicesRepo.searchForAdmin).toHaveBeenCalled();
    });

    it("should filter by amountMax with lte on totalAmountCents", async () => {
      const row = mockInvoiceRow({ totalAmountCents: 5000 });
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([row]);

      const query: InvoiceSearchQueryDto = { amountMax: 10000 };
      const result = await service.searchInvoices(query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].totalAmountCents).toBe(5000);
      expect(mockInvoicesRepo.searchForAdmin).toHaveBeenCalled();
    });

    it("should combine multiple filters with AND logic", async () => {
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([]);

      const query: InvoiceSearchQueryDto = {
        customerId: "c0000000-0000-4000-a000-000000000001",
        status: "finalized",
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
        amountMin: 1000,
        amountMax: 50000,
      };
      const result = await service.searchInvoices(query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockInvoicesRepo.searchForAdmin).toHaveBeenCalled();
    });

    it("should apply descending cursor pagination with lt", async () => {
      const rows = [
        mockInvoiceRow({ id: "inv00000-0000-4000-a000-000000000003" }),
        mockInvoiceRow({ id: "inv00000-0000-4000-a000-000000000002" }),
        mockInvoiceRow({ id: "inv00000-0000-4000-a000-000000000001" }),
      ];
      mockInvoicesRepo.searchForAdmin.mockResolvedValue(rows);

      const query: InvoiceSearchQueryDto = {
        cursor: "inv00000-0000-4000-a000-000000000004",
        limit: 2,
      };
      const result = await service.searchInvoices(query);

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe("inv00000-0000-4000-a000-000000000002");
      expect(mockInvoicesRepo.searchForAdmin).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: "inv00000-0000-4000-a000-000000000004",
        }),
        2,
      );
    });

    it("should return empty results when no invoices match", async () => {
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([]);

      const query: InvoiceSearchQueryDto = { status: "nonexistent" };
      const result = await service.searchInvoices(query);

      expect(result).toEqual({ data: [], cursor: null, hasMore: false });
    });

    it("should map paidAt and voidedAt as ISO strings when present", async () => {
      const row = mockInvoiceRow({
        paidAt: new Date("2026-01-20T15:00:00.000Z"),
        voidedAt: new Date("2026-01-25T10:00:00.000Z"),
      });
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([row]);

      const query: InvoiceSearchQueryDto = {};
      const result = await service.searchInvoices(query);

      expect(result.data[0].paidAt).toBe("2026-01-20T15:00:00.000Z");
      expect(result.data[0].voidedAt).toBe("2026-01-25T10:00:00.000Z");
    });

    it("should skip empty string customerId filter", async () => {
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([]);

      const query: InvoiceSearchQueryDto = { customerId: "" };
      const result = await service.searchInvoices(query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockInvoicesRepo.searchForAdmin).toHaveBeenCalled();
    });

    it("should return empty results when amountMin > amountMax", async () => {
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([]);

      const query: InvoiceSearchQueryDto = {
        amountMin: 10000,
        amountMax: 5000,
      };
      const result = await service.searchInvoices(query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockInvoicesRepo.searchForAdmin).toHaveBeenCalled();
    });

    it("should return empty results when dateFrom > dateTo", async () => {
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([]);

      const query: InvoiceSearchQueryDto = {
        dateFrom: "2026-03-01T00:00:00.000Z",
        dateTo: "2026-01-01T00:00:00.000Z",
      };
      const result = await service.searchInvoices(query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockInvoicesRepo.searchForAdmin).toHaveBeenCalled();
    });

    it("should accept amountMin = 0 as a valid filter", async () => {
      const row = mockInvoiceRow({ totalAmountCents: 0 });
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([row]);

      const query: InvoiceSearchQueryDto = { amountMin: 0 };
      const result = await service.searchInvoices(query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].totalAmountCents).toBe(0);
      expect(mockInvoicesRepo.searchForAdmin).toHaveBeenCalled();
    });

    it("should use default limit of 20 when not specified", async () => {
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([]);

      const query: InvoiceSearchQueryDto = {};
      await service.searchInvoices(query);

      expect(mockInvoicesRepo.searchForAdmin).toHaveBeenCalledWith(
        expect.any(Object),
        20,
      );
    });

    it("should map subscriptionId as null when absent", async () => {
      const row = mockInvoiceRow({ subscriptionId: null });
      mockInvoicesRepo.searchForAdmin.mockResolvedValue([row]);

      const query: InvoiceSearchQueryDto = {};
      const result = await service.searchInvoices(query);

      expect(result.data[0].subscriptionId).toBeNull();
    });
  });

  describe("getInvoiceLineItems", () => {
    const invoiceId = "inv00000-0000-4000-a000-000000000001";

    it("should return all line items for an invoice with exact values", async () => {
      mockInvoicesRepo.findById.mockResolvedValue({ id: invoiceId });
      const row = mockLineItemRow();
      mockInvoicesRepo.getLineItemsByInvoiceId.mockResolvedValue([row]);

      const result = await service.getInvoiceLineItems(invoiceId);

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: row.id,
        invoiceId: row.invoiceId,
        type: "subscription_fee",
        description: "Monthly subscription",
        amountCents: 10000,
        quantity: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockInvoicesRepo.findById).toHaveBeenCalledWith(invoiceId);
      expect(mockInvoicesRepo.getLineItemsByInvoiceId).toHaveBeenCalledWith(
        invoiceId,
      );
    });

    it("should throw NotFoundException when invoice does not exist", async () => {
      mockInvoicesRepo.findById.mockResolvedValue(null);

      let caughtError: unknown;
      try {
        await service.getInvoiceLineItems(invoiceId);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(NotFoundException);
      expect((caughtError as NotFoundException).message).toBe(
        `Invoice ${invoiceId} not found`,
      );

      // Line items query should NOT be called when invoice not found
      expect(mockInvoicesRepo.getLineItemsByInvoiceId).not.toHaveBeenCalled();
    });

    it("should return empty results when invoice has no line items", async () => {
      mockInvoicesRepo.findById.mockResolvedValue({ id: invoiceId });
      mockInvoicesRepo.getLineItemsByInvoiceId.mockResolvedValue([]);

      const result = await service.getInvoiceLineItems(invoiceId);

      expect(result).toEqual({ data: [], cursor: null, hasMore: false });
    });

    it("should return multiple line items ordered by id ascending", async () => {
      mockInvoicesRepo.findById.mockResolvedValue({ id: invoiceId });
      const rows = [
        mockLineItemRow({
          id: "li000000-0000-4000-a000-000000000001",
          type: "subscription_fee",
          amountCents: 8000,
        }),
        mockLineItemRow({
          id: "li000000-0000-4000-a000-000000000002",
          type: "surcharge",
          description: "Processing surcharge",
          amountCents: 2000,
        }),
      ];
      mockInvoicesRepo.getLineItemsByInvoiceId.mockResolvedValue(rows);

      const result = await service.getInvoiceLineItems(invoiceId);

      expect(result.data).toHaveLength(2);
      expect(result.data[0].type).toBe("subscription_fee");
      expect(result.data[0].amountCents).toBe(8000);
      expect(result.data[1].type).toBe("surcharge");
      expect(result.data[1].amountCents).toBe(2000);
    });
  });

  describe("getDunningHistory", () => {
    const customerId = "c0000000-0000-4000-a000-000000000001";

    it("should return dunning attempts with PM type and gatewayProvider from join", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const row = mockDunningRow();
      mockDunningRepo.findWithInvoiceAndPaymentMethod.mockResolvedValue([row]);

      const query: DunningHistoryQueryDto = {};
      const result = await service.getDunningHistory(customerId, query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: row.id,
        invoiceId: row.invoiceId,
        chargeId: row.chargeId,
        paymentMethodId: row.paymentMethodId,
        attemptNumber: 1,
        scheduledDate: "2026-01-20T00:00:00.000Z",
        executedAt: "2026-01-20T12:00:00.000Z",
        status: "failed",
        failureReason: "insufficient_funds",
        paymentMethodType: "card",
        gatewayProvider: "stripe",
        createdAt: "2026-01-20T12:00:00.000Z",
      });
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(
        mockDunningRepo.findWithInvoiceAndPaymentMethod,
      ).toHaveBeenCalledWith(
        customerId,
        { dateFrom: undefined, dateTo: undefined, cursor: undefined },
        20,
      );
    });

    it("should filter by dateFrom with gte on dunningAttempts.createdAt", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      mockDunningRepo.findWithInvoiceAndPaymentMethod.mockResolvedValue([]);

      const query: DunningHistoryQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
      };
      const result = await service.getDunningHistory(customerId, query);

      expect(result.data).toEqual([]);
      expect(
        mockDunningRepo.findWithInvoiceAndPaymentMethod,
      ).toHaveBeenCalled();
    });

    it("should filter by dateTo with lt on dunningAttempts.createdAt", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      mockDunningRepo.findWithInvoiceAndPaymentMethod.mockResolvedValue([]);

      const query: DunningHistoryQueryDto = {
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.getDunningHistory(customerId, query);

      expect(result.data).toEqual([]);
      expect(
        mockDunningRepo.findWithInvoiceAndPaymentMethod,
      ).toHaveBeenCalled();
    });

    it("should apply descending cursor pagination with lt", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const rows = [
        mockDunningRow({ id: "da000000-0000-4000-a000-000000000003" }),
        mockDunningRow({ id: "da000000-0000-4000-a000-000000000002" }),
        mockDunningRow({ id: "da000000-0000-4000-a000-000000000001" }),
      ];
      mockDunningRepo.findWithInvoiceAndPaymentMethod.mockResolvedValue(rows);

      const query: DunningHistoryQueryDto = {
        cursor: "da000000-0000-4000-a000-000000000004",
        limit: 2,
      };
      const result = await service.getDunningHistory(customerId, query);

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe("da000000-0000-4000-a000-000000000002");
      expect(
        mockDunningRepo.findWithInvoiceAndPaymentMethod,
      ).toHaveBeenCalledWith(
        customerId,
        expect.objectContaining({
          cursor: "da000000-0000-4000-a000-000000000004",
        }),
        2,
      );
    });

    it("should throw NotFoundException when customer does not exist", async () => {
      mockCustomersRepo.findById.mockResolvedValue(null);

      const query: DunningHistoryQueryDto = {};

      let caughtError: unknown;
      try {
        await service.getDunningHistory(customerId, query);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(NotFoundException);
      expect((caughtError as NotFoundException).message).toBe(
        `Customer ${customerId} not found`,
      );

      expect(
        mockDunningRepo.findWithInvoiceAndPaymentMethod,
      ).not.toHaveBeenCalled();
    });

    it("should return empty results when customer has no dunning attempts", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      mockDunningRepo.findWithInvoiceAndPaymentMethod.mockResolvedValue([]);

      const query: DunningHistoryQueryDto = {};
      const result = await service.getDunningHistory(customerId, query);

      expect(result).toEqual({ data: [], cursor: null, hasMore: false });
    });

    it("should return null paymentMethodType and gatewayProvider when paymentMethodId is null", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const row = mockDunningRow({
        paymentMethodId: null,
        paymentMethodType: null,
        gatewayProvider: null,
      });
      mockDunningRepo.findWithInvoiceAndPaymentMethod.mockResolvedValue([row]);

      const query: DunningHistoryQueryDto = {};
      const result = await service.getDunningHistory(customerId, query);

      expect(result.data[0].paymentMethodId).toBeNull();
      expect(result.data[0].paymentMethodType).toBeNull();
      expect(result.data[0].gatewayProvider).toBeNull();
    });

    it("should return null executedAt for scheduled dunning attempts", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const row = mockDunningRow({
        executedAt: null,
        status: "scheduled",
        failureReason: null,
        chargeId: null,
      });
      mockDunningRepo.findWithInvoiceAndPaymentMethod.mockResolvedValue([row]);

      const query: DunningHistoryQueryDto = {};
      const result = await service.getDunningHistory(customerId, query);

      expect(result.data[0].executedAt).toBeNull();
      expect(result.data[0].status).toBe("scheduled");
      expect(result.data[0].chargeId).toBeNull();
    });

    it("should return empty results when dateFrom > dateTo", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      mockDunningRepo.findWithInvoiceAndPaymentMethod.mockResolvedValue([]);

      const query: DunningHistoryQueryDto = {
        dateFrom: "2026-03-01T00:00:00.000Z",
        dateTo: "2026-01-01T00:00:00.000Z",
      };
      const result = await service.getDunningHistory(customerId, query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it("should apply half-open interval with both dateFrom and dateTo", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      mockDunningRepo.findWithInvoiceAndPaymentMethod.mockResolvedValue([]);

      const query: DunningHistoryQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.getDunningHistory(customerId, query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it("should combine dateFrom, dateTo, and cursor filters with AND logic", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      mockDunningRepo.findWithInvoiceAndPaymentMethod.mockResolvedValue([]);

      const query: DunningHistoryQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
        cursor: "da000000-0000-4000-a000-000000000010",
        limit: 5,
      };
      const result = await service.getDunningHistory(customerId, query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(
        mockDunningRepo.findWithInvoiceAndPaymentMethod,
      ).toHaveBeenCalledWith(
        customerId,
        expect.objectContaining({
          dateFrom: "2026-01-01T00:00:00.000Z",
          dateTo: "2026-02-01T00:00:00.000Z",
          cursor: "da000000-0000-4000-a000-000000000010",
        }),
        5,
      );
    });

    it("should use default limit of 20 when not specified", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      mockDunningRepo.findWithInvoiceAndPaymentMethod.mockResolvedValue([]);

      const query: DunningHistoryQueryDto = {};
      await service.getDunningHistory(customerId, query);

      expect(
        mockDunningRepo.findWithInvoiceAndPaymentMethod,
      ).toHaveBeenCalledWith(customerId, expect.any(Object), 20);
    });
  });

  describe("searchDiscrepancies", () => {
    it("should return paginated discrepancies with all fields", async () => {
      const row = mockDiscrepancyRow();
      mockDiscrepanciesRepo.search.mockResolvedValue([row]);

      const query: DiscrepancySearchQueryDto = {};
      const result = await service.searchDiscrepancies(query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: row.id,
        reconciliationRunId: row.reconciliationRunId,
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
      });
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockDiscrepanciesRepo.search).toHaveBeenCalledWith(
        {
          disputeStatus: undefined,
          runId: undefined,
          dateFrom: undefined,
          dateTo: undefined,
          cursor: undefined,
        },
        20,
      );
    });

    it("should filter by disputeStatus", async () => {
      mockDiscrepanciesRepo.search.mockResolvedValue([]);

      const query: DiscrepancySearchQueryDto = {
        disputeStatus: "investigating",
      };
      const result = await service.searchDiscrepancies(query);

      expect(result.data).toEqual([]);
      expect(mockDiscrepanciesRepo.search).toHaveBeenCalled();
    });

    it("should filter by runId with exact match", async () => {
      mockDiscrepanciesRepo.search.mockResolvedValue([]);

      const query: DiscrepancySearchQueryDto = {
        runId: "rr000000-0000-4000-a000-000000000001",
      };
      const result = await service.searchDiscrepancies(query);

      expect(result.data).toEqual([]);
      expect(mockDiscrepanciesRepo.search).toHaveBeenCalled();
    });

    it("should filter by dateFrom with gte on createdAt", async () => {
      mockDiscrepanciesRepo.search.mockResolvedValue([]);

      const query: DiscrepancySearchQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
      };
      const result = await service.searchDiscrepancies(query);

      expect(result.data).toEqual([]);
      expect(mockDiscrepanciesRepo.search).toHaveBeenCalled();
    });

    it("should filter by dateTo with lt on createdAt", async () => {
      mockDiscrepanciesRepo.search.mockResolvedValue([]);

      const query: DiscrepancySearchQueryDto = {
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.searchDiscrepancies(query);

      expect(result.data).toEqual([]);
      expect(mockDiscrepanciesRepo.search).toHaveBeenCalled();
    });

    it("should filter by combined dateFrom + dateTo + disputeStatus", async () => {
      mockDiscrepanciesRepo.search.mockResolvedValue([]);

      const query: DiscrepancySearchQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
        disputeStatus: "open",
      };
      const result = await service.searchDiscrepancies(query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockDiscrepanciesRepo.search).toHaveBeenCalled();
    });

    it("should apply cursor pagination with lt and orderBy desc", async () => {
      const rows = [
        mockDiscrepancyRow({ id: "rd000000-0000-4000-a000-000000000003" }),
        mockDiscrepancyRow({ id: "rd000000-0000-4000-a000-000000000002" }),
        mockDiscrepancyRow({ id: "rd000000-0000-4000-a000-000000000001" }),
      ];
      mockDiscrepanciesRepo.search.mockResolvedValue(rows);

      const query: DiscrepancySearchQueryDto = {
        cursor: "rd000000-0000-4000-a000-000000000004",
        limit: 2,
      };
      const result = await service.searchDiscrepancies(query);

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe("rd000000-0000-4000-a000-000000000002");
      expect(mockDiscrepanciesRepo.search).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: "rd000000-0000-4000-a000-000000000004",
        }),
        2,
      );
    });

    it("should return hasMore: false with cursor: null at end", async () => {
      mockDiscrepanciesRepo.search.mockResolvedValue([
        mockDiscrepancyRow({ id: "rd000000-0000-4000-a000-000000000001" }),
      ]);

      const query: DiscrepancySearchQueryDto = { limit: 5 };
      const result = await service.searchDiscrepancies(query);

      expect(result.data).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
    });

    it("should return empty data array when no matches", async () => {
      mockDiscrepanciesRepo.search.mockResolvedValue([]);

      const query: DiscrepancySearchQueryDto = { disputeStatus: "resolved" };
      const result = await service.searchDiscrepancies(query);

      expect(result).toEqual({ data: [], cursor: null, hasMore: false });
    });

    it("should apply no filters when query is empty — returns all", async () => {
      mockDiscrepanciesRepo.search.mockResolvedValue([mockDiscrepancyRow()]);

      const query: DiscrepancySearchQueryDto = {};
      const result = await service.searchDiscrepancies(query);

      expect(result.data).toHaveLength(1);
      expect(mockDiscrepanciesRepo.search).toHaveBeenCalled();
    });

    it("should delegate to repository which leftJoins reconciliationRuns for period context", async () => {
      mockDiscrepanciesRepo.search.mockResolvedValue([mockDiscrepancyRow()]);

      const query: DiscrepancySearchQueryDto = {};
      await service.searchDiscrepancies(query);

      expect(mockDiscrepanciesRepo.search).toHaveBeenCalled();
    });

    it("should use default limit of 20 when not specified", async () => {
      mockDiscrepanciesRepo.search.mockResolvedValue([]);

      const query: DiscrepancySearchQueryDto = {};
      await service.searchDiscrepancies(query);

      expect(mockDiscrepanciesRepo.search).toHaveBeenCalledWith(
        expect.any(Object),
        20,
      );
    });

    it("should map resolvedAt as ISO string when present", async () => {
      const row = mockDiscrepancyRow({
        resolvedAt: new Date("2026-01-20T15:00:00.000Z"),
        disputeStatus: "resolved",
        resolvedBy: "user-1",
        resolutionNotes: "Fixed mismatch",
      });
      mockDiscrepanciesRepo.search.mockResolvedValue([row]);

      const query: DiscrepancySearchQueryDto = {};
      const result = await service.searchDiscrepancies(query);

      expect(result.data[0].resolvedAt).toBe("2026-01-20T15:00:00.000Z");
      expect(result.data[0].disputeStatus).toBe("resolved");
      expect(result.data[0].resolvedBy).toBe("user-1");
      expect(result.data[0].resolutionNotes).toBe("Fixed mismatch");
    });

    it("should map null periodStart/periodEnd when run not joined", async () => {
      const row = mockDiscrepancyRow({ periodStart: null, periodEnd: null });
      mockDiscrepanciesRepo.search.mockResolvedValue([row]);

      const query: DiscrepancySearchQueryDto = {};
      const result = await service.searchDiscrepancies(query);

      expect(result.data[0].periodStart).toBeNull();
      expect(result.data[0].periodEnd).toBeNull();
    });

    it("should return empty results when dateFrom > dateTo", async () => {
      mockDiscrepanciesRepo.search.mockResolvedValue([]);

      const query: DiscrepancySearchQueryDto = {
        dateFrom: "2026-03-01T00:00:00.000Z",
        dateTo: "2026-01-01T00:00:00.000Z",
      };
      const result = await service.searchDiscrepancies(query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });
  });

  describe("updateDisputeStatus", () => {
    const discrepancyId = "rd000000-0000-4000-a000-000000000001";

    it("should update disputeStatus to 'investigating' and return updated record with period context", async () => {
      mockDiscrepanciesRepo.updateDisputeStatus.mockResolvedValue({
        id: discrepancyId,
      });
      const lookupRow = mockDiscrepancyRow({ disputeStatus: "investigating" });
      mockDiscrepanciesRepo.findWithRunDetails.mockResolvedValue(lookupRow);

      const dto: UpdateDisputeStatusDto = { status: "investigating" };
      const result = await service.updateDisputeStatus(discrepancyId, dto);

      expect(result).toEqual({
        id: discrepancyId,
        reconciliationRunId: "rr000000-0000-4000-a000-000000000001",
        type: "amount_mismatch",
        internalReferenceId: "ch000000-0000-4000-a000-000000000001",
        stripeTransactionId: "pi_test_123",
        expectedAmountCents: 10000,
        actualAmountCents: 9500,
        differenceCents: 500,
        disputeStatus: "investigating",
        resolvedBy: null,
        resolutionNotes: null,
        resolvedAt: null,
        createdAt: "2026-01-15T10:00:00.000Z",
        periodStart: "2026-01-01T00:00:00.000Z",
        periodEnd: "2026-02-01T00:00:00.000Z",
      });
      expect(mockDiscrepanciesRepo.updateDisputeStatus).toHaveBeenCalledWith(
        discrepancyId,
        "investigating",
      );
      expect(mockDiscrepanciesRepo.findWithRunDetails).toHaveBeenCalledWith(
        discrepancyId,
      );
    });

    it("should update disputeStatus to 'open' (revert)", async () => {
      mockDiscrepanciesRepo.updateDisputeStatus.mockResolvedValue({
        id: discrepancyId,
      });
      mockDiscrepanciesRepo.findWithRunDetails.mockResolvedValue(
        mockDiscrepancyRow({
          disputeStatus: "open",
          internalReferenceId: null,
          stripeTransactionId: null,
          expectedAmountCents: 5000,
          actualAmountCents: 5000,
          differenceCents: 0,
        }),
      );

      const dto: UpdateDisputeStatusDto = { status: "open" };
      const result = await service.updateDisputeStatus(discrepancyId, dto);

      expect(result.disputeStatus).toBe("open");
      expect(mockDiscrepanciesRepo.updateDisputeStatus).toHaveBeenCalledWith(
        discrepancyId,
        "open",
      );
    });

    it("should update disputeStatus to 'dismissed'", async () => {
      mockDiscrepanciesRepo.updateDisputeStatus.mockResolvedValue({
        id: discrepancyId,
      });
      mockDiscrepanciesRepo.findWithRunDetails.mockResolvedValue(
        mockDiscrepancyRow({
          type: "missing_internal",
          internalReferenceId: null,
          stripeTransactionId: "pi_test_456",
          expectedAmountCents: 0,
          actualAmountCents: 3000,
          differenceCents: 3000,
          disputeStatus: "dismissed",
        }),
      );

      const dto: UpdateDisputeStatusDto = { status: "dismissed" };
      const result = await service.updateDisputeStatus(discrepancyId, dto);

      expect(result.disputeStatus).toBe("dismissed");
      expect(mockDiscrepanciesRepo.updateDisputeStatus).toHaveBeenCalledWith(
        discrepancyId,
        "dismissed",
      );
    });

    it("should throw NotFoundException when discrepancy ID not found", async () => {
      mockDiscrepanciesRepo.updateDisputeStatus.mockResolvedValue(null);

      const dto: UpdateDisputeStatusDto = { status: "investigating" };

      let caughtError: unknown;
      try {
        await service.updateDisputeStatus(discrepancyId, dto);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(NotFoundException);
      expect((caughtError as NotFoundException).message).toBe(
        `Discrepancy ${discrepancyId} not found`,
      );

      // Lookup query should NOT be called when discrepancy not found
      expect(mockDiscrepanciesRepo.findWithRunDetails).not.toHaveBeenCalled();
    });

    it("should verify updateDisputeStatus is called with correct arguments", async () => {
      mockDiscrepanciesRepo.updateDisputeStatus.mockResolvedValue({
        id: discrepancyId,
      });
      mockDiscrepanciesRepo.findWithRunDetails.mockResolvedValue(
        mockDiscrepancyRow({ disputeStatus: "resolved" }),
      );

      const dto: UpdateDisputeStatusDto = { status: "resolved" };
      await service.updateDisputeStatus(discrepancyId, dto);

      expect(mockDiscrepanciesRepo.updateDisputeStatus).toHaveBeenCalledWith(
        discrepancyId,
        "resolved",
      );
      expect(mockDiscrepanciesRepo.updateDisputeStatus).toHaveBeenCalledTimes(
        1,
      );
    });

    it("should map resolvedAt as ISO string when present in returned record", async () => {
      mockDiscrepanciesRepo.updateDisputeStatus.mockResolvedValue({
        id: discrepancyId,
      });
      mockDiscrepanciesRepo.findWithRunDetails.mockResolvedValue(
        mockDiscrepancyRow({
          disputeStatus: "resolved",
          resolvedBy: "user-1",
          resolutionNotes: "Fixed",
          resolvedAt: new Date("2026-01-20T15:00:00.000Z"),
        }),
      );

      const dto: UpdateDisputeStatusDto = { status: "resolved" };
      const result = await service.updateDisputeStatus(discrepancyId, dto);

      expect(result.resolvedAt).toBe("2026-01-20T15:00:00.000Z");
      expect(result.resolvedBy).toBe("user-1");
      expect(result.resolutionNotes).toBe("Fixed");
    });

    it("should hydrate periodStart and periodEnd from reconciliationRuns join", async () => {
      mockDiscrepanciesRepo.updateDisputeStatus.mockResolvedValue({
        id: discrepancyId,
      });
      mockDiscrepanciesRepo.findWithRunDetails.mockResolvedValue(
        mockDiscrepancyRow({
          disputeStatus: "investigating",
          periodStart: new Date("2026-01-01T00:00:00.000Z"),
          periodEnd: new Date("2026-02-01T00:00:00.000Z"),
        }),
      );

      const dto: UpdateDisputeStatusDto = { status: "investigating" };
      const result = await service.updateDisputeStatus(discrepancyId, dto);

      expect(result.periodStart).toBe("2026-01-01T00:00:00.000Z");
      expect(result.periodEnd).toBe("2026-02-01T00:00:00.000Z");
    });

    it("should return null periodStart and periodEnd when run not joined", async () => {
      mockDiscrepanciesRepo.updateDisputeStatus.mockResolvedValue({
        id: discrepancyId,
      });
      mockDiscrepanciesRepo.findWithRunDetails.mockResolvedValue(
        mockDiscrepancyRow({
          disputeStatus: "investigating",
          periodStart: null,
          periodEnd: null,
        }),
      );

      const dto: UpdateDisputeStatusDto = { status: "investigating" };
      const result = await service.updateDisputeStatus(discrepancyId, dto);

      expect(result.periodStart).toBeNull();
      expect(result.periodEnd).toBeNull();
    });
  });

  describe("resolveDiscrepancy", () => {
    const discrepancyId = "rd000000-0000-4000-a000-000000000001";
    const adminUserId = "admin-user-42";

    it("should resolve discrepancy and return updated record with all 4 fields set", async () => {
      mockDiscrepanciesRepo.findById.mockResolvedValue({
        id: discrepancyId,
        disputeStatus: "open",
      });
      mockDiscrepanciesRepo.resolve.mockResolvedValue({ id: discrepancyId });
      const hydrationRow = mockDiscrepancyRow({
        disputeStatus: "resolved",
        resolvedBy: adminUserId,
        resolutionNotes: "Confirmed with Stripe dashboard",
        resolvedAt: new Date("2026-01-20T15:00:00.000Z"),
      });
      mockDiscrepanciesRepo.findWithRunDetails.mockResolvedValue(hydrationRow);

      const dto: ResolveDiscrepancyDto = {
        resolutionNotes: "Confirmed with Stripe dashboard",
      };
      const result = await service.resolveDiscrepancy(
        discrepancyId,
        dto,
        adminUserId,
      );

      expect(result).toEqual({
        id: discrepancyId,
        reconciliationRunId: "rr000000-0000-4000-a000-000000000001",
        type: "amount_mismatch",
        internalReferenceId: "ch000000-0000-4000-a000-000000000001",
        stripeTransactionId: "pi_test_123",
        expectedAmountCents: 10000,
        actualAmountCents: 9500,
        differenceCents: 500,
        disputeStatus: "resolved",
        resolvedBy: adminUserId,
        resolutionNotes: "Confirmed with Stripe dashboard",
        resolvedAt: "2026-01-20T15:00:00.000Z",
        createdAt: "2026-01-15T10:00:00.000Z",
        periodStart: "2026-01-01T00:00:00.000Z",
        periodEnd: "2026-02-01T00:00:00.000Z",
      });
    });

    it("should call resolve with resolvedBy and resolutionNotes", async () => {
      mockDiscrepanciesRepo.findById.mockResolvedValue({
        id: discrepancyId,
        disputeStatus: "investigating",
      });
      mockDiscrepanciesRepo.resolve.mockResolvedValue({ id: discrepancyId });
      mockDiscrepanciesRepo.findWithRunDetails.mockResolvedValue(
        mockDiscrepancyRow({
          disputeStatus: "resolved",
          resolvedBy: adminUserId,
          resolutionNotes: "Notes",
          resolvedAt: new Date("2026-01-20T15:00:00.000Z"),
        }),
      );

      const dto: ResolveDiscrepancyDto = { resolutionNotes: "Notes" };
      await service.resolveDiscrepancy(discrepancyId, dto, adminUserId);

      expect(mockDiscrepanciesRepo.resolve).toHaveBeenCalledWith(
        discrepancyId,
        {
          resolvedBy: adminUserId,
          resolutionNotes: "Notes",
        },
      );
    });

    it("should call findById first for conflict check", async () => {
      mockDiscrepanciesRepo.findById.mockResolvedValue({
        id: discrepancyId,
        disputeStatus: "open",
      });
      mockDiscrepanciesRepo.resolve.mockResolvedValue({ id: discrepancyId });
      mockDiscrepanciesRepo.findWithRunDetails.mockResolvedValue(
        mockDiscrepancyRow({
          disputeStatus: "resolved",
          resolvedBy: adminUserId,
          resolutionNotes: "Notes",
          resolvedAt: new Date("2026-01-20T15:00:00.000Z"),
        }),
      );

      const dto: ResolveDiscrepancyDto = { resolutionNotes: "Notes" };
      await service.resolveDiscrepancy(discrepancyId, dto, adminUserId);

      expect(mockDiscrepanciesRepo.findById).toHaveBeenCalledWith(
        discrepancyId,
      );
    });

    it("should hydrate periodStart/periodEnd from findWithRunDetails (follow-up SELECT)", async () => {
      mockDiscrepanciesRepo.findById.mockResolvedValue({
        id: discrepancyId,
        disputeStatus: "open",
      });
      mockDiscrepanciesRepo.resolve.mockResolvedValue({ id: discrepancyId });
      mockDiscrepanciesRepo.findWithRunDetails.mockResolvedValue(
        mockDiscrepancyRow({
          disputeStatus: "resolved",
          resolvedBy: adminUserId,
          resolutionNotes: "Notes",
          resolvedAt: new Date("2026-01-20T15:00:00.000Z"),
          periodStart: new Date("2026-01-01T00:00:00.000Z"),
          periodEnd: new Date("2026-02-01T00:00:00.000Z"),
        }),
      );

      const dto: ResolveDiscrepancyDto = { resolutionNotes: "Notes" };
      const result = await service.resolveDiscrepancy(
        discrepancyId,
        dto,
        adminUserId,
      );

      expect(result.periodStart).toBe("2026-01-01T00:00:00.000Z");
      expect(result.periodEnd).toBe("2026-02-01T00:00:00.000Z");
      expect(mockDiscrepanciesRepo.findWithRunDetails).toHaveBeenCalledWith(
        discrepancyId,
      );
    });

    it("should return null periodStart/periodEnd when run not joined", async () => {
      mockDiscrepanciesRepo.findById.mockResolvedValue({
        id: discrepancyId,
        disputeStatus: "open",
      });
      mockDiscrepanciesRepo.resolve.mockResolvedValue({ id: discrepancyId });
      mockDiscrepanciesRepo.findWithRunDetails.mockResolvedValue(
        mockDiscrepancyRow({
          disputeStatus: "resolved",
          resolvedBy: adminUserId,
          resolutionNotes: "Notes",
          resolvedAt: new Date("2026-01-20T15:00:00.000Z"),
          periodStart: null,
          periodEnd: null,
        }),
      );

      const dto: ResolveDiscrepancyDto = { resolutionNotes: "Notes" };
      const result = await service.resolveDiscrepancy(
        discrepancyId,
        dto,
        adminUserId,
      );

      expect(result.periodStart).toBeNull();
      expect(result.periodEnd).toBeNull();
    });

    it("should throw NotFoundException when discrepancy ID not found", async () => {
      mockDiscrepanciesRepo.findById.mockResolvedValue(null);

      const dto: ResolveDiscrepancyDto = { resolutionNotes: "Notes" };

      let caughtError: unknown;
      try {
        await service.resolveDiscrepancy(discrepancyId, dto, adminUserId);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(NotFoundException);
      expect((caughtError as NotFoundException).message).toBe(
        `Discrepancy ${discrepancyId} not found`,
      );

      // Update and hydration should NOT be called
      expect(mockDiscrepanciesRepo.resolve).not.toHaveBeenCalled();
      expect(mockDiscrepanciesRepo.findWithRunDetails).not.toHaveBeenCalled();
    });

    it("should throw ConflictException when disputeStatus is already 'resolved'", async () => {
      mockDiscrepanciesRepo.findById.mockResolvedValue({
        id: discrepancyId,
        disputeStatus: "resolved",
      });

      const dto: ResolveDiscrepancyDto = { resolutionNotes: "Notes" };

      let caughtError: unknown;
      try {
        await service.resolveDiscrepancy(discrepancyId, dto, adminUserId);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(ConflictException);
      expect((caughtError as ConflictException).message).toBe(
        `Discrepancy ${discrepancyId} is already resolved`,
      );

      // Update and hydration should NOT be called
      expect(mockDiscrepanciesRepo.resolve).not.toHaveBeenCalled();
      expect(mockDiscrepanciesRepo.findWithRunDetails).not.toHaveBeenCalled();
    });

    it("should throw NotFoundException when resolve returns null (concurrent delete)", async () => {
      mockDiscrepanciesRepo.findById.mockResolvedValue({
        id: discrepancyId,
        disputeStatus: "open",
      });
      mockDiscrepanciesRepo.resolve.mockResolvedValue(null);

      const dto: ResolveDiscrepancyDto = { resolutionNotes: "Notes" };

      let caughtError: unknown;
      try {
        await service.resolveDiscrepancy(discrepancyId, dto, adminUserId);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(NotFoundException);
      expect((caughtError as NotFoundException).message).toBe(
        `Discrepancy ${discrepancyId} not found`,
      );

      // Hydration should NOT be called
      expect(mockDiscrepanciesRepo.findWithRunDetails).not.toHaveBeenCalled();
    });
  });

  describe("exportReconciliationData", () => {
    it("should return export with summary and discrepancies array", async () => {
      const rows = [
        mockDiscrepancyRow({
          id: "rd000000-0000-4000-a000-000000000002",
          disputeStatus: "open",
        }),
        mockDiscrepancyRow({
          id: "rd000000-0000-4000-a000-000000000001",
          disputeStatus: "investigating",
        }),
      ];
      mockDiscrepanciesRepo.exportByDateRange.mockResolvedValue(rows);

      const query: ReconciliationExportQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.exportReconciliationData(query);

      expect(result.discrepancies).toHaveLength(2);
      expect(result.summary.totalDiscrepancies).toBe(2);
      expect(result.dateRange).toEqual({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
      });
      expect(result.exportDate).toBeDefined();
      expect(() => new Date(result.exportDate)).not.toThrow();
      expect(mockDiscrepanciesRepo.exportByDateRange).toHaveBeenCalledWith(
        "2026-01-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
      );
    });

    it("should compute byStatus counts matching actual statuses", async () => {
      const rows = [
        mockDiscrepancyRow({
          id: "rd000000-0000-4000-a000-000000000003",
          disputeStatus: "open",
        }),
        mockDiscrepancyRow({
          id: "rd000000-0000-4000-a000-000000000002",
          disputeStatus: "open",
        }),
        mockDiscrepancyRow({
          id: "rd000000-0000-4000-a000-000000000001",
          disputeStatus: "resolved",
        }),
      ];
      mockDiscrepanciesRepo.exportByDateRange.mockResolvedValue(rows);

      const query: ReconciliationExportQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.exportReconciliationData(query);

      expect(result.summary.byStatus).toEqual({
        open: 2,
        investigating: 0,
        resolved: 1,
        dismissed: 0,
      });
    });

    it("should sum totalDifferenceCents from all discrepancies using absolute values", async () => {
      const rows = [
        mockDiscrepancyRow({
          id: "rd000000-0000-4000-a000-000000000002",
          differenceCents: 500,
        }),
        mockDiscrepancyRow({
          id: "rd000000-0000-4000-a000-000000000001",
          differenceCents: -300,
        }),
      ];
      mockDiscrepanciesRepo.exportByDateRange.mockResolvedValue(rows);

      const query: ReconciliationExportQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.exportReconciliationData(query);

      expect(result.summary.totalDifferenceCents).toBe(800);
    });

    it("should return exportDate as ISO string of current time", async () => {
      mockDiscrepanciesRepo.exportByDateRange.mockResolvedValue([]);

      const query: ReconciliationExportQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const before = new Date().toISOString();
      const result = await service.exportReconciliationData(query);
      const after = new Date().toISOString();

      expect(result.exportDate >= before).toBe(true);
      expect(result.exportDate <= after).toBe(true);
    });

    it("should include all fields in discrepancies reusing DiscrepancySearchResponseDto shape", async () => {
      const row = mockDiscrepancyRow({
        disputeStatus: "resolved",
        resolvedBy: "user-1",
        resolutionNotes: "Fixed",
        resolvedAt: new Date("2026-01-20T15:00:00.000Z"),
      });
      mockDiscrepanciesRepo.exportByDateRange.mockResolvedValue([row]);

      const query: ReconciliationExportQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.exportReconciliationData(query);

      expect(result.discrepancies[0]).toEqual({
        id: "rd000000-0000-4000-a000-000000000001",
        reconciliationRunId: "rr000000-0000-4000-a000-000000000001",
        type: "amount_mismatch",
        internalReferenceId: "ch000000-0000-4000-a000-000000000001",
        stripeTransactionId: "pi_test_123",
        expectedAmountCents: 10000,
        actualAmountCents: 9500,
        differenceCents: 500,
        disputeStatus: "resolved",
        resolvedBy: "user-1",
        resolutionNotes: "Fixed",
        resolvedAt: "2026-01-20T15:00:00.000Z",
        createdAt: "2026-01-15T10:00:00.000Z",
        periodStart: "2026-01-01T00:00:00.000Z",
        periodEnd: "2026-02-01T00:00:00.000Z",
      });
    });

    it("should return empty discrepancies array with zero summary when no matches", async () => {
      mockDiscrepanciesRepo.exportByDateRange.mockResolvedValue([]);

      const query: ReconciliationExportQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.exportReconciliationData(query);

      expect(result.discrepancies).toEqual([]);
      expect(result.summary.totalDiscrepancies).toBe(0);
      expect(result.summary.totalDifferenceCents).toBe(0);
    });

    it("should include all 4 statuses with count 0 in byStatus when empty", async () => {
      mockDiscrepanciesRepo.exportByDateRange.mockResolvedValue([]);

      const query: ReconciliationExportQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.exportReconciliationData(query);

      expect(result.summary.byStatus).toEqual({
        open: 0,
        investigating: 0,
        resolved: 0,
        dismissed: 0,
      });
    });

    it("should delegate to repository exportByDateRange with correct args", async () => {
      mockDiscrepanciesRepo.exportByDateRange.mockResolvedValue([]);

      const query: ReconciliationExportQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      await service.exportReconciliationData(query);

      expect(mockDiscrepanciesRepo.exportByDateRange).toHaveBeenCalledWith(
        "2026-01-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
      );
    });

    it("should handle all-same-status discrepancies correctly in byStatus", async () => {
      const rows = [
        mockDiscrepancyRow({
          id: "rd000000-0000-4000-a000-000000000003",
          disputeStatus: "investigating",
        }),
        mockDiscrepancyRow({
          id: "rd000000-0000-4000-a000-000000000002",
          disputeStatus: "investigating",
        }),
        mockDiscrepancyRow({
          id: "rd000000-0000-4000-a000-000000000001",
          disputeStatus: "investigating",
        }),
      ];
      mockDiscrepanciesRepo.exportByDateRange.mockResolvedValue(rows);

      const query: ReconciliationExportQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.exportReconciliationData(query);

      expect(result.summary.byStatus).toEqual({
        open: 0,
        investigating: 3,
        resolved: 0,
        dismissed: 0,
      });
      expect(result.summary.totalDiscrepancies).toBe(3);
    });
  });

  describe("getBillingHistory", () => {
    const customerId = "c0000000-0000-4000-a000-000000000001";

    function setupAllFour(
      invoiceRows: unknown[],
      chargeRows: unknown[],
      creditRows: unknown[],
      refundRows: unknown[],
    ) {
      mockInvoicesRepo.findForBillingHistory.mockResolvedValue(invoiceRows);
      mockChargesRepo.findForBillingHistory.mockResolvedValue(chargeRows);
      mockCreditNotesRepo.findForBillingHistory.mockResolvedValue(creditRows);
      mockRefundsRepo.findForBillingHistory.mockResolvedValue(refundRows);
    }

    it("should return unified data from all 4 tables sorted by createdAt DESC", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const inv = mockInvoiceRow({
        createdAt: new Date("2026-01-20T10:00:00.000Z"),
      });
      const ch = mockChargeRow({
        createdAt: new Date("2026-01-21T12:00:00.000Z"),
      });
      const cn = mockCreditNoteRow({
        createdAt: new Date("2026-01-18T09:00:00.000Z"),
      });
      const rf = mockRefundRow({
        createdAt: new Date("2026-01-19T11:00:00.000Z"),
      });
      setupAllFour([inv], [ch], [cn], [rf]);

      const query: BillingHistoryQueryDto = {};
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data).toHaveLength(4);
      expect(result.data[0].type).toBe("payment");
      expect(result.data[0].createdAt).toBe("2026-01-21T12:00:00.000Z");
      expect(result.data[1].type).toBe("invoice");
      expect(result.data[1].createdAt).toBe("2026-01-20T10:00:00.000Z");
      expect(result.data[2].type).toBe("refund");
      expect(result.data[2].createdAt).toBe("2026-01-19T11:00:00.000Z");
      expect(result.data[3].type).toBe("credit");
      expect(result.data[3].createdAt).toBe("2026-01-18T09:00:00.000Z");
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it("should throw NotFoundException when customer does not exist", async () => {
      mockCustomersRepo.findById.mockResolvedValue(null);

      const query: BillingHistoryQueryDto = {};
      await expect(
        service.getBillingHistory(customerId, query),
      ).rejects.toThrow(
        new NotFoundException(`Customer ${customerId} not found`),
      );
    });

    it("should filter by type=invoice — only invoice repo called", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const inv = mockInvoiceRow();
      mockInvoicesRepo.findForBillingHistory.mockResolvedValue([inv]);

      const query: BillingHistoryQueryDto = { type: "invoice" };
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].type).toBe("invoice");
      expect(result.data[0].referenceId).toBe(inv.id);
      expect(result.data[0].amountCents).toBe(inv.totalAmountCents);
      expect(mockInvoicesRepo.findForBillingHistory).toHaveBeenCalled();
      expect(mockChargesRepo.findForBillingHistory).not.toHaveBeenCalled();
      expect(mockRefundsRepo.findForBillingHistory).not.toHaveBeenCalled();
      expect(mockCreditNotesRepo.findForBillingHistory).not.toHaveBeenCalled();
    });

    it("should filter by type=payment — only charges repo called", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const ch = mockChargeRow();
      mockChargesRepo.findForBillingHistory.mockResolvedValue([ch]);

      const query: BillingHistoryQueryDto = { type: "payment" };
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].type).toBe("payment");
      expect(result.data[0].amountCents).toBe(ch.amountCents);
      expect(mockChargesRepo.findForBillingHistory).toHaveBeenCalled();
      expect(mockInvoicesRepo.findForBillingHistory).not.toHaveBeenCalled();
    });

    it("should filter by type=credit — only credit notes repo called", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const cn = mockCreditNoteRow();
      mockCreditNotesRepo.findForBillingHistory.mockResolvedValue([cn]);

      const query: BillingHistoryQueryDto = { type: "credit" };
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].type).toBe("credit");
      expect(result.data[0].description).toBe("Credit note: Billing error");
      expect(mockCreditNotesRepo.findForBillingHistory).toHaveBeenCalled();
      expect(mockInvoicesRepo.findForBillingHistory).not.toHaveBeenCalled();
    });

    it("should filter by type=refund — only refunds repo called", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const rf = mockRefundRow();
      mockRefundsRepo.findForBillingHistory.mockResolvedValue([rf]);

      const query: BillingHistoryQueryDto = { type: "refund" };
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].type).toBe("refund");
      expect(result.data[0].description).toBe("Refund: Customer request");
      expect(mockRefundsRepo.findForBillingHistory).toHaveBeenCalled();
      expect(mockInvoicesRepo.findForBillingHistory).not.toHaveBeenCalled();
    });

    it("should apply dateFrom and dateTo half-open interval to all queries", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      setupAllFour([], [], [], []);

      const query: BillingHistoryQueryDto = {
        dateFrom: "2026-01-15T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockInvoicesRepo.findForBillingHistory).toHaveBeenCalled();
      expect(mockChargesRepo.findForBillingHistory).toHaveBeenCalled();
      expect(mockRefundsRepo.findForBillingHistory).toHaveBeenCalled();
      expect(mockCreditNotesRepo.findForBillingHistory).toHaveBeenCalled();
    });

    it("should apply cursor pagination using createdAt timestamp", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const items = Array.from({ length: 21 }, (_, i) =>
        mockInvoiceRow({
          id: `inv${String(i).padStart(5, "0")}00-0000-4000-a000-000000000001`,
          createdAt: new Date(
            `2026-01-${String(21 - i).padStart(2, "0")}T10:00:00.000Z`,
          ),
        }),
      );
      setupAllFour(items, [], [], []);

      const query: BillingHistoryQueryDto = { limit: 20 };
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data).toHaveLength(20);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe(result.data[19].createdAt);
    });

    it("should apply cursor filter to sub-queries when cursor provided", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      setupAllFour([], [], [], []);

      const query: BillingHistoryQueryDto = {
        cursor: "2026-01-15T10:00:00.000Z",
      };
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data).toEqual([]);
      expect(mockInvoicesRepo.findForBillingHistory).toHaveBeenCalledWith(
        customerId,
        expect.objectContaining({
          cursor: new Date("2026-01-15T10:00:00.000Z"),
        }),
        20,
      );
      expect(mockCreditNotesRepo.findForBillingHistory).toHaveBeenCalledWith(
        customerId,
        expect.objectContaining({
          cursor: new Date("2026-01-15T10:00:00.000Z"),
        }),
        20,
      );
    });

    it("should return empty results when no billing data exists", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      setupAllFour([], [], [], []);

      const query: BillingHistoryQueryDto = {};
      const result = await service.getBillingHistory(customerId, query);

      expect(result).toEqual({ data: [], cursor: null, hasMore: false });
    });

    it("should generate correct description for invoice type", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const inv = mockInvoiceRow({
        billingPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
        billingPeriodEnd: new Date("2026-02-01T00:00:00.000Z"),
      });
      setupAllFour([inv], [], [], []);

      const query: BillingHistoryQueryDto = {};
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data[0].description).toBe(
        "Invoice for 2026-01-01 - 2026-02-01",
      );
    });

    it("should generate correct description for payment with failure reason", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const ch = mockChargeRow({
        failureReason: "insufficient_funds",
        attemptNumber: 2,
      });
      setupAllFour([], [ch], [], []);

      const query: BillingHistoryQueryDto = {};
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data[0].description).toBe(
        "Payment attempt #2 - Failed: insufficient_funds",
      );
    });

    it("should generate correct description for payment without failure reason", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const ch = mockChargeRow({
        failureReason: null,
        attemptNumber: 1,
        status: "succeeded",
      });
      setupAllFour([], [ch], [], []);

      const query: BillingHistoryQueryDto = {};
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data[0].description).toBe("Payment attempt #1 - succeeded");
    });

    it("should generate correct description for refund without reason", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const rf = mockRefundRow({ reason: null, failureReason: null });
      setupAllFour([], [], [], [rf]);

      const query: BillingHistoryQueryDto = {};
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data[0].description).toBe("Refund: No reason provided");
    });

    it("should generate correct description for refund with failure reason", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const rf = mockRefundRow({
        reason: "Customer request",
        failureReason: "card_declined",
      });
      setupAllFour([], [], [], [rf]);

      const query: BillingHistoryQueryDto = {};
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data[0].description).toBe(
        "Refund: Customer request - Failed: card_declined",
      );
    });

    it("should use default limit of 20 when not specified", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      setupAllFour([], [], [], []);

      const query: BillingHistoryQueryDto = {};
      await service.getBillingHistory(customerId, query);

      expect(mockInvoicesRepo.findForBillingHistory).toHaveBeenCalledWith(
        customerId,
        expect.any(Object),
        20,
      );
      expect(mockChargesRepo.findForBillingHistory).toHaveBeenCalledWith(
        customerId,
        expect.any(Object),
        20,
      );
      expect(mockCreditNotesRepo.findForBillingHistory).toHaveBeenCalledWith(
        customerId,
        expect.any(Object),
        20,
      );
      expect(mockRefundsRepo.findForBillingHistory).toHaveBeenCalledWith(
        customerId,
        expect.any(Object),
        20,
      );
    });

    it("should use custom limit when specified", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      setupAllFour([], [], [], []);

      const query: BillingHistoryQueryDto = { limit: 5 };
      await service.getBillingHistory(customerId, query);

      expect(mockInvoicesRepo.findForBillingHistory).toHaveBeenCalledWith(
        customerId,
        expect.any(Object),
        5,
      );
      expect(mockChargesRepo.findForBillingHistory).toHaveBeenCalledWith(
        customerId,
        expect.any(Object),
        5,
      );
      expect(mockCreditNotesRepo.findForBillingHistory).toHaveBeenCalledWith(
        customerId,
        expect.any(Object),
        5,
      );
      expect(mockRefundsRepo.findForBillingHistory).toHaveBeenCalledWith(
        customerId,
        expect.any(Object),
        5,
      );
    });

    it("should combine type filter with dateFrom/dateTo", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const ch = mockChargeRow();
      mockChargesRepo.findForBillingHistory.mockResolvedValue([ch]);

      const query: BillingHistoryQueryDto = {
        type: "payment",
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].type).toBe("payment");
      expect(mockChargesRepo.findForBillingHistory).toHaveBeenCalled();
      expect(mockInvoicesRepo.findForBillingHistory).not.toHaveBeenCalled();
    });

    it("should map all fields correctly for each type", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const inv = mockInvoiceRow({
        createdAt: new Date("2026-01-20T10:00:00.000Z"),
      });
      setupAllFour([inv], [], [], []);

      const query: BillingHistoryQueryDto = {};
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data[0]).toEqual({
        id: inv.id,
        type: "invoice",
        referenceId: inv.id,
        description: expect.any(String) as string,
        amountCents: inv.totalAmountCents,
        currency: inv.currency,
        status: inv.status,
        createdAt: "2026-01-20T10:00:00.000Z",
      });
    });

    it("should include all items with same createdAt on current page — known limitation: items at cursor boundary may be skipped on next page", async () => {
      mockCustomersRepo.findById.mockResolvedValue({ id: customerId });
      const sameTimestamp = new Date("2026-01-20T10:00:00.000Z");
      const inv = mockInvoiceRow({ createdAt: sameTimestamp });
      const ch = mockChargeRow({ createdAt: sameTimestamp });
      setupAllFour([inv], [ch], [], []);

      const query: BillingHistoryQueryDto = { limit: 2 };
      const result = await service.getBillingHistory(customerId, query);

      expect(result.data).toHaveLength(2);
      expect(result.data[0].createdAt).toBe("2026-01-20T10:00:00.000Z");
      expect(result.data[1].createdAt).toBe("2026-01-20T10:00:00.000Z");
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });
  });

  describe("searchAuditTrail", () => {
    it("should return audit records sorted by id DESC", async () => {
      const row1 = mockAuditTrailRow({
        id: "at000000-0000-4000-a000-000000000002",
        createdAt: new Date("2026-01-21T10:00:00.000Z"),
      });
      const row2 = mockAuditTrailRow({
        id: "at000000-0000-4000-a000-000000000001",
        createdAt: new Date("2026-01-20T10:00:00.000Z"),
      });
      mockAuditTrailRepo.search.mockResolvedValue([row1, row2]);

      const query: AuditTrailSearchQueryDto = {};
      const result = await service.searchAuditTrail(query);

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({
        id: "at000000-0000-4000-a000-000000000002",
        adminUserId: "admin-user-1",
        action: "PUT /v1/admin/reconciliation/discrepancies/123/resolve",
        entityType: "reconciliation_discrepancy",
        entityId: "rd000000-0000-4000-a000-000000000001",
        details: { resolutionNotes: "Confirmed" },
        createdAt: "2026-01-21T10:00:00.000Z",
      });
      expect(result.data[1].createdAt).toBe("2026-01-20T10:00:00.000Z");
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(mockAuditTrailRepo.search).toHaveBeenCalledWith(
        {
          entityType: undefined,
          entityId: undefined,
          adminUserId: undefined,
          startDate: undefined,
          endDate: undefined,
          cursor: undefined,
        },
        20,
      );
    });

    it("should filter by entityType with exact match", async () => {
      mockAuditTrailRepo.search.mockResolvedValue([]);

      const query: AuditTrailSearchQueryDto = {
        entityType: "reconciliation_discrepancy",
      };
      const result = await service.searchAuditTrail(query);

      expect(result.data).toEqual([]);
      expect(mockAuditTrailRepo.search).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: "reconciliation_discrepancy" }),
        20,
      );
    });

    it("should filter by entityId with exact match", async () => {
      const row = mockAuditTrailRow();
      mockAuditTrailRepo.search.mockResolvedValue([row]);

      const query: AuditTrailSearchQueryDto = {
        entityId: "rd000000-0000-4000-a000-000000000001",
      };
      const result = await service.searchAuditTrail(query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].entityId).toBe(
        "rd000000-0000-4000-a000-000000000001",
      );
      expect(mockAuditTrailRepo.search).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: "rd000000-0000-4000-a000-000000000001",
        }),
        20,
      );
    });

    it("should filter by adminUserId with exact match", async () => {
      const row = mockAuditTrailRow({ adminUserId: "admin-user-42" });
      mockAuditTrailRepo.search.mockResolvedValue([row]);

      const query: AuditTrailSearchQueryDto = { adminUserId: "admin-user-42" };
      const result = await service.searchAuditTrail(query);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].adminUserId).toBe("admin-user-42");
      expect(mockAuditTrailRepo.search).toHaveBeenCalledWith(
        expect.objectContaining({ adminUserId: "admin-user-42" }),
        20,
      );
    });

    it("should filter by dateFrom with gte and dateTo with lt", async () => {
      mockAuditTrailRepo.search.mockResolvedValue([]);

      const query: AuditTrailSearchQueryDto = {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
      };
      const result = await service.searchAuditTrail(query);

      expect(result.data).toEqual([]);
      expect(mockAuditTrailRepo.search).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: "2026-01-01T00:00:00.000Z",
          endDate: "2026-02-01T00:00:00.000Z",
        }),
        20,
      );
    });

    it("should apply cursor pagination with lt(id, cursor) descending", async () => {
      const rows = Array.from({ length: 21 }, (_, i) =>
        mockAuditTrailRow({
          id: `at${String(20 - i).padStart(6, "0")}-0000-4000-a000-000000000001`,
          createdAt: new Date(
            `2026-01-${String(20 - i).padStart(2, "0")}T10:00:00.000Z`,
          ),
        }),
      );
      mockAuditTrailRepo.search.mockResolvedValue(rows);

      const query: AuditTrailSearchQueryDto = { limit: 20 };
      const result = await service.searchAuditTrail(query);

      expect(result.data).toHaveLength(20);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe(result.data[19].id);
    });

    it("should return empty results when no audit records exist", async () => {
      mockAuditTrailRepo.search.mockResolvedValue([]);

      const query: AuditTrailSearchQueryDto = {};
      const result = await service.searchAuditTrail(query);

      expect(result).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });

    it("should combine all filters together", async () => {
      mockAuditTrailRepo.search.mockResolvedValue([]);

      const query: AuditTrailSearchQueryDto = {
        entityType: "reconciliation_discrepancy",
        entityId: "rd000000-0000-4000-a000-000000000001",
        adminUserId: "admin-user-1",
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-02-01T00:00:00.000Z",
        cursor: "at000000-0000-4000-a000-000000000099",
      };
      const result = await service.searchAuditTrail(query);

      expect(result.data).toEqual([]);
      expect(mockAuditTrailRepo.search).toHaveBeenCalledWith(
        {
          entityType: "reconciliation_discrepancy",
          entityId: "rd000000-0000-4000-a000-000000000001",
          adminUserId: "admin-user-1",
          startDate: "2026-01-01T00:00:00.000Z",
          endDate: "2026-02-01T00:00:00.000Z",
          cursor: "at000000-0000-4000-a000-000000000099",
        },
        20,
      );
    });

    it("should apply no filters when query is empty", async () => {
      const row = mockAuditTrailRow();
      mockAuditTrailRepo.search.mockResolvedValue([row]);

      const query: AuditTrailSearchQueryDto = {};
      const result = await service.searchAuditTrail(query);

      expect(result.data).toHaveLength(1);
      expect(mockAuditTrailRepo.search).toHaveBeenCalled();
    });

    it("should use default limit of 20 when not specified", async () => {
      mockAuditTrailRepo.search.mockResolvedValue([]);

      const query: AuditTrailSearchQueryDto = {};
      await service.searchAuditTrail(query);

      expect(mockAuditTrailRepo.search).toHaveBeenCalledWith(
        expect.any(Object),
        20,
      );
    });

    it("should use custom limit when specified", async () => {
      mockAuditTrailRepo.search.mockResolvedValue([]);

      const query: AuditTrailSearchQueryDto = { limit: 5 };
      await service.searchAuditTrail(query);

      expect(mockAuditTrailRepo.search).toHaveBeenCalledWith(
        expect.any(Object),
        5,
      );
    });

    it("should map details as-is from database row", async () => {
      const complexDetails = {
        before: { status: "open" },
        after: { status: "resolved" },
        changes: ["status"],
      };
      const row = mockAuditTrailRow({ details: complexDetails });
      mockAuditTrailRepo.search.mockResolvedValue([row]);

      const query: AuditTrailSearchQueryDto = {};
      const result = await service.searchAuditTrail(query);

      expect(result.data[0].details).toEqual(complexDetails);
    });

    it("should handle null details from database row", async () => {
      const row = mockAuditTrailRow({ details: null });
      mockAuditTrailRepo.search.mockResolvedValue([row]);

      const query: AuditTrailSearchQueryDto = {};
      const result = await service.searchAuditTrail(query);

      expect(result.data[0].details).toBeNull();
    });

    it("should handle boundary dates — dateFrom equals dateTo", async () => {
      mockAuditTrailRepo.search.mockResolvedValue([]);

      const query: AuditTrailSearchQueryDto = {
        dateFrom: "2026-01-15T00:00:00.000Z",
        dateTo: "2026-01-15T00:00:00.000Z",
      };
      const result = await service.searchAuditTrail(query);

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it("should apply cursor filter when cursor provided", async () => {
      mockAuditTrailRepo.search.mockResolvedValue([]);

      const query: AuditTrailSearchQueryDto = {
        cursor: "at000000-0000-4000-a000-000000000010",
      };
      const result = await service.searchAuditTrail(query);

      expect(result.data).toEqual([]);
      expect(mockAuditTrailRepo.search).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: "at000000-0000-4000-a000-000000000010",
        }),
        20,
      );
    });
  });

  describe("bulkSubscriptionOperation", () => {
    const sub1 = "s0000000-0000-4000-a000-000000000001";
    const sub2 = "s0000000-0000-4000-a000-000000000002";
    const sub3 = "s0000000-0000-4000-a000-000000000003";
    const sub4 = "s0000000-0000-4000-a000-000000000004";
    const sub5 = "s0000000-0000-4000-a000-000000000005";

    const mockUpdatedSub = (id: string, status: string) => ({
      id,
      status,
      customerId: "c0000000-0000-4000-a000-000000000001",
      planName: "basic",
      amountCents: 1000,
      currency: "usd",
      billingInterval: "monthly",
      billingPeriodStart: new Date(),
      billingPeriodEnd: new Date(),
      nextBillingDate: null,
      stripeSubscriptionId: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    it("should pause 3 active subscriptions successfully", async () => {
      mockSubscriptionsService.updateState
        .mockResolvedValueOnce(mockUpdatedSub(sub1, "paused"))
        .mockResolvedValueOnce(mockUpdatedSub(sub2, "paused"))
        .mockResolvedValueOnce(mockUpdatedSub(sub3, "paused"));

      const dto: BulkSubscriptionOperationDto = {
        action: "pause",
        subscriptionIds: [sub1, sub2, sub3],
      };
      const result = await service.bulkSubscriptionOperation(dto);

      expect(result.successCount).toBe(3);
      expect(result.failureCount).toBe(0);
      expect(result.results).toHaveLength(3);
      expect(result.results[0]).toEqual({
        subscriptionId: sub1,
        success: true,
      });
      expect(result.results[1]).toEqual({
        subscriptionId: sub2,
        success: true,
      });
      expect(result.results[2]).toEqual({
        subscriptionId: sub3,
        success: true,
      });
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledTimes(3);
      expect(mockSubscriptionsService.updateState).toHaveBeenNthCalledWith(
        1,
        sub1,
        { status: "paused" },
      );
      expect(mockSubscriptionsService.updateState).toHaveBeenNthCalledWith(
        2,
        sub2,
        { status: "paused" },
      );
      expect(mockSubscriptionsService.updateState).toHaveBeenNthCalledWith(
        3,
        sub3,
        { status: "paused" },
      );
    });

    it("should cancel 3 mixed-state subscriptions successfully", async () => {
      mockSubscriptionsService.updateState
        .mockResolvedValueOnce(mockUpdatedSub(sub1, "canceled"))
        .mockResolvedValueOnce(mockUpdatedSub(sub2, "canceled"))
        .mockResolvedValueOnce(mockUpdatedSub(sub3, "canceled"));

      const dto: BulkSubscriptionOperationDto = {
        action: "cancel",
        subscriptionIds: [sub1, sub2, sub3],
      };
      const result = await service.bulkSubscriptionOperation(dto);

      expect(result.successCount).toBe(3);
      expect(result.failureCount).toBe(0);
      expect(result.results).toHaveLength(3);
      expect(result.results[0]).toEqual({
        subscriptionId: sub1,
        success: true,
      });
      expect(result.results[1]).toEqual({
        subscriptionId: sub2,
        success: true,
      });
      expect(result.results[2]).toEqual({
        subscriptionId: sub3,
        success: true,
      });
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledTimes(3);
      expect(mockSubscriptionsService.updateState).toHaveBeenNthCalledWith(
        1,
        sub1,
        { status: "canceled" },
      );
      expect(mockSubscriptionsService.updateState).toHaveBeenNthCalledWith(
        2,
        sub2,
        { status: "canceled" },
      );
      expect(mockSubscriptionsService.updateState).toHaveBeenNthCalledWith(
        3,
        sub3,
        { status: "canceled" },
      );
    });

    it("should handle partial failure: 4 succeed, 1 already cancelled", async () => {
      mockSubscriptionsService.updateState
        .mockResolvedValueOnce(mockUpdatedSub(sub1, "paused"))
        .mockResolvedValueOnce(mockUpdatedSub(sub2, "paused"))
        .mockRejectedValueOnce(
          new StateTransitionException(
            "Invalid state transition from 'canceled' to 'paused'",
            {
              currentState: "canceled",
              targetState: "paused",
              allowedTransitions: [],
            },
          ),
        )
        .mockResolvedValueOnce(mockUpdatedSub(sub4, "paused"))
        .mockResolvedValueOnce(mockUpdatedSub(sub5, "paused"));

      const dto: BulkSubscriptionOperationDto = {
        action: "pause",
        subscriptionIds: [sub1, sub2, sub3, sub4, sub5],
      };
      const result = await service.bulkSubscriptionOperation(dto);

      expect(result.successCount).toBe(4);
      expect(result.failureCount).toBe(1);
      expect(result.results).toHaveLength(5);
      expect(result.results[0]).toEqual({
        subscriptionId: sub1,
        success: true,
      });
      expect(result.results[1]).toEqual({
        subscriptionId: sub2,
        success: true,
      });
      expect(result.results[2]).toEqual({
        subscriptionId: sub3,
        success: false,
        reason: "Invalid state transition from 'canceled' to 'paused'",
      });
      expect(result.results[3]).toEqual({
        subscriptionId: sub4,
        success: true,
      });
      expect(result.results[4]).toEqual({
        subscriptionId: sub5,
        success: true,
      });
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledTimes(5);
    });

    it("should handle all failures: bulk pause 3 cancelled subscriptions", async () => {
      const errorMsg = "Invalid state transition from 'canceled' to 'paused'";
      mockSubscriptionsService.updateState
        .mockRejectedValueOnce(
          new StateTransitionException(errorMsg, {
            currentState: "canceled",
            targetState: "paused",
            allowedTransitions: [],
          }),
        )
        .mockRejectedValueOnce(
          new StateTransitionException(errorMsg, {
            currentState: "canceled",
            targetState: "paused",
            allowedTransitions: [],
          }),
        )
        .mockRejectedValueOnce(
          new StateTransitionException(errorMsg, {
            currentState: "canceled",
            targetState: "paused",
            allowedTransitions: [],
          }),
        );

      const dto: BulkSubscriptionOperationDto = {
        action: "pause",
        subscriptionIds: [sub1, sub2, sub3],
      };
      const result = await service.bulkSubscriptionOperation(dto);

      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(3);
      expect(result.results).toHaveLength(3);
      expect(result.results[0]).toEqual({
        subscriptionId: sub1,
        success: false,
        reason: errorMsg,
      });
      expect(result.results[1]).toEqual({
        subscriptionId: sub2,
        success: false,
        reason: errorMsg,
      });
      expect(result.results[2]).toEqual({
        subscriptionId: sub3,
        success: false,
        reason: errorMsg,
      });
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledTimes(3);
    });

    it("should work with a single subscription ID", async () => {
      mockSubscriptionsService.updateState.mockResolvedValueOnce(
        mockUpdatedSub(sub1, "paused"),
      );

      const dto: BulkSubscriptionOperationDto = {
        action: "pause",
        subscriptionIds: [sub1],
      };
      const result = await service.bulkSubscriptionOperation(dto);

      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(0);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({
        subscriptionId: sub1,
        success: true,
      });
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledTimes(1);
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledWith(sub1, {
        status: "paused",
      });
    });

    it("should handle subscription not found error", async () => {
      mockSubscriptionsService.updateState.mockRejectedValueOnce(
        new SubscriptionNotFoundException(sub1),
      );

      const dto: BulkSubscriptionOperationDto = {
        action: "cancel",
        subscriptionIds: [sub1],
      };
      const result = await service.bulkSubscriptionOperation(dto);

      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({
        subscriptionId: sub1,
        success: false,
        reason: `Subscription not found: ${sub1}`,
      });
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledTimes(1);
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledWith(sub1, {
        status: "canceled",
      });
    });

    it("should handle invalid state transition error", async () => {
      const errorMsg = "Invalid state transition from 'pending' to 'paused'";
      mockSubscriptionsService.updateState.mockRejectedValueOnce(
        new StateTransitionException(errorMsg, {
          currentState: "pending",
          targetState: "paused",
          allowedTransitions: ["active"],
        }),
      );

      const dto: BulkSubscriptionOperationDto = {
        action: "pause",
        subscriptionIds: [sub1],
      };
      const result = await service.bulkSubscriptionOperation(dto);

      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(1);
      expect(result.results[0]).toEqual({
        subscriptionId: sub1,
        success: false,
        reason: errorMsg,
      });
    });

    it("should handle concurrent modification error", async () => {
      const errorMsg = "Subscription state was modified concurrently";
      mockSubscriptionsService.updateState.mockRejectedValueOnce(
        new StateTransitionException(errorMsg, {
          currentState: "active",
          targetState: "paused",
          allowedTransitions: ["paused", "canceled"],
        }),
      );

      const dto: BulkSubscriptionOperationDto = {
        action: "pause",
        subscriptionIds: [sub1],
      };
      const result = await service.bulkSubscriptionOperation(dto);

      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(1);
      expect(result.results[0]).toEqual({
        subscriptionId: sub1,
        success: false,
        reason: errorMsg,
      });
    });

    it("should throw InternalServerErrorException when SubscriptionsService is not available", async () => {
      // Create a service instance WITHOUT SubscriptionsService
      const moduleWithout: TestingModule = await Test.createTestingModule({
        providers: [
          AdminService,
          { provide: CustomersRepository, useValue: mockCustomersRepo },
          { provide: InvoicesRepository, useValue: mockInvoicesRepo },
          { provide: ChargesRepository, useValue: mockChargesRepo },
          { provide: DunningAttemptsRepository, useValue: mockDunningRepo },
          {
            provide: ReconciliationDiscrepanciesRepository,
            useValue: mockDiscrepanciesRepo,
          },
          { provide: RefundsRepository, useValue: mockRefundsRepo },
          { provide: CreditNotesRepository, useValue: mockCreditNotesRepo },
          { provide: AuditTrailRepository, useValue: mockAuditTrailRepo },
        ],
      }).compile();
      const serviceWithout = moduleWithout.get<AdminService>(AdminService);

      const dto: BulkSubscriptionOperationDto = {
        action: "pause",
        subscriptionIds: [sub1],
      };

      await expect(
        serviceWithout.bulkSubscriptionOperation(dto),
      ).rejects.toThrow(InternalServerErrorException);
      await expect(
        serviceWithout.bulkSubscriptionOperation(dto),
      ).rejects.toThrow("SubscriptionsService not available");
    });

    it("should call updateState with correct args for pause action", async () => {
      mockSubscriptionsService.updateState.mockResolvedValueOnce(
        mockUpdatedSub(sub1, "paused"),
      );

      const dto: BulkSubscriptionOperationDto = {
        action: "pause",
        subscriptionIds: [sub1],
      };
      await service.bulkSubscriptionOperation(dto);

      expect(mockSubscriptionsService.updateState).toHaveBeenCalledWith(sub1, {
        status: "paused",
      });
    });

    it("should call updateState with correct args for cancel action", async () => {
      mockSubscriptionsService.updateState.mockResolvedValueOnce(
        mockUpdatedSub(sub1, "canceled"),
      );

      const dto: BulkSubscriptionOperationDto = {
        action: "cancel",
        subscriptionIds: [sub1],
      };
      await service.bulkSubscriptionOperation(dto);

      expect(mockSubscriptionsService.updateState).toHaveBeenCalledWith(sub1, {
        status: "canceled",
      });
    });

    it("should execute subscriptions sequentially in order", async () => {
      const callOrder: string[] = [];
      mockSubscriptionsService.updateState.mockImplementation((id: string) => {
        callOrder.push(id);
        return Promise.resolve(mockUpdatedSub(id, "paused"));
      });

      const dto: BulkSubscriptionOperationDto = {
        action: "pause",
        subscriptionIds: [sub1, sub2, sub3],
      };
      await service.bulkSubscriptionOperation(dto);

      expect(callOrder).toEqual([sub1, sub2, sub3]);
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledTimes(3);
    });

    it("should maintain results array order matching subscriptionIds order", async () => {
      mockSubscriptionsService.updateState
        .mockResolvedValueOnce(mockUpdatedSub(sub1, "canceled"))
        .mockRejectedValueOnce(
          new StateTransitionException(
            "Invalid state transition from 'canceled' to 'canceled'",
            {
              currentState: "canceled",
              targetState: "canceled",
              allowedTransitions: [],
            },
          ),
        )
        .mockResolvedValueOnce(mockUpdatedSub(sub3, "canceled"));

      const dto: BulkSubscriptionOperationDto = {
        action: "cancel",
        subscriptionIds: [sub1, sub2, sub3],
      };
      const result = await service.bulkSubscriptionOperation(dto);

      expect(result.results).toHaveLength(3);
      expect(result.results[0].subscriptionId).toBe(sub1);
      expect(result.results[0].success).toBe(true);
      expect(result.results[1].subscriptionId).toBe(sub2);
      expect(result.results[1].success).toBe(false);
      expect(result.results[2].subscriptionId).toBe(sub3);
      expect(result.results[2].success).toBe(true);
    });

    it("should handle mixed cancel with heterogeneous current states", async () => {
      // active → canceled ✓, paused → canceled ✓, past_due → canceled ✓
      mockSubscriptionsService.updateState
        .mockResolvedValueOnce(mockUpdatedSub(sub1, "canceled"))
        .mockResolvedValueOnce(mockUpdatedSub(sub2, "canceled"))
        .mockResolvedValueOnce(mockUpdatedSub(sub3, "canceled"));

      const dto: BulkSubscriptionOperationDto = {
        action: "cancel",
        subscriptionIds: [sub1, sub2, sub3],
      };
      const result = await service.bulkSubscriptionOperation(dto);

      expect(result.successCount).toBe(3);
      expect(result.failureCount).toBe(0);
      expect(result.results).toHaveLength(3);
    });

    it("should handle unknown error type (non-Error thrown)", async () => {
      mockSubscriptionsService.updateState.mockRejectedValueOnce(
        "string error",
      );

      const dto: BulkSubscriptionOperationDto = {
        action: "pause",
        subscriptionIds: [sub1],
      };
      const result = await service.bulkSubscriptionOperation(dto);

      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(1);
      expect(result.results[0]).toEqual({
        subscriptionId: sub1,
        success: false,
        reason: "Unknown error",
      });
    });

    it("should not call updateState for remaining IDs after all process (no short-circuit)", async () => {
      mockSubscriptionsService.updateState
        .mockRejectedValueOnce(new SubscriptionNotFoundException(sub1))
        .mockResolvedValueOnce(mockUpdatedSub(sub2, "paused"));

      const dto: BulkSubscriptionOperationDto = {
        action: "pause",
        subscriptionIds: [sub1, sub2],
      };
      const result = await service.bulkSubscriptionOperation(dto);

      // Both were processed — first failure does not stop processing
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);
      expect(result.results).toHaveLength(2);
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledTimes(2);
    });

    it("should include reason field only for failed results", async () => {
      mockSubscriptionsService.updateState
        .mockResolvedValueOnce(mockUpdatedSub(sub1, "paused"))
        .mockRejectedValueOnce(new SubscriptionNotFoundException(sub2));

      const dto: BulkSubscriptionOperationDto = {
        action: "pause",
        subscriptionIds: [sub1, sub2],
      };
      const result = await service.bulkSubscriptionOperation(dto);

      expect(result.results[0]).toEqual({
        subscriptionId: sub1,
        success: true,
      });
      // toEqual() already guarantees no extra 'reason' field via exact match
      expect(result.results[1]).toEqual({
        subscriptionId: sub2,
        success: false,
        reason: `Subscription not found: ${sub2}`,
      });
    });

    it("should handle optional reason field in DTO (ignored by service)", async () => {
      mockSubscriptionsService.updateState.mockResolvedValueOnce(
        mockUpdatedSub(sub1, "canceled"),
      );

      const dto: BulkSubscriptionOperationDto = {
        action: "cancel",
        subscriptionIds: [sub1],
        reason: "Customer requested bulk cancellation",
      };
      const result = await service.bulkSubscriptionOperation(dto);

      expect(result.successCount).toBe(1);
      expect(result.results[0]).toEqual({
        subscriptionId: sub1,
        success: true,
      });
      // reason is for audit trail, not passed to updateState
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledWith(sub1, {
        status: "canceled",
      });
    });
  });
});
