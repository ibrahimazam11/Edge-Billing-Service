import { Logger } from "@nestjs/common";
import { MigrationValidationService } from "./migration-validation.service";
import type { CustomersRepository } from "../customers/customers.repository";
import type { InvoicesRepository } from "../invoices/invoices.repository";
import type { ReconciliationService } from "../reconciliation/reconciliation.service";
import type { Pool, QueryResult } from "pg";

describe("MigrationValidationService", () => {
  let service: MigrationValidationService;
  let mockCustomersRepository: { findById: jest.Mock };
  let mockInvoicesRepository: { getBillingStatsForMigration: jest.Mock };
  let mockMonolithPool: { query: jest.Mock };
  let mockReconciliationService: { runDailyReconciliation: jest.Mock };

  beforeEach(() => {
    mockCustomersRepository = {
      findById: jest.fn().mockResolvedValue(null),
    };

    mockInvoicesRepository = {
      getBillingStatsForMigration: jest.fn().mockResolvedValue({
        count: 0,
        paidCount: 0,
        totalCents: 0,
      }),
    };

    mockMonolithPool = {
      query: jest.fn(),
    };

    mockReconciliationService = {
      runDailyReconciliation: jest.fn(),
    };

    service = new MigrationValidationService(
      mockCustomersRepository as unknown as CustomersRepository,
      mockInvoicesRepository as unknown as InvoicesRepository,
      mockMonolithPool as unknown as Pool,
      mockReconciliationService as unknown as ReconciliationService,
    );

    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const mockCustomer = {
    id: "cust-uuid-1",
    monolithCustomerId: "MONO-001",
  };

  const makeMonolithResult = (
    count: number,
    paidCount: number,
    totalDollars: number,
  ): QueryResult => ({
    rows: [{ count, paid_count: paidCount, total_dollars: totalDollars }],
    command: "SELECT",
    rowCount: 1,
    oid: 0,
    fields: [],
  });

  describe("validateCustomer", () => {
    it("should return consistent when billing and monolith data match", async () => {
      mockCustomersRepository.findById.mockResolvedValue(mockCustomer);

      // Monolith: 5 charges at $100 each ($500 total), 3 paid
      mockMonolithPool.query
        .mockResolvedValueOnce(makeMonolithResult(5, 3, 500))
        .mockResolvedValueOnce(makeMonolithResult(2, 2, 200));

      // Billing: 5 charge invoices at 50000 cents, 2 payroll invoices at 20000 cents
      mockInvoicesRepository.getBillingStatsForMigration
        .mockResolvedValueOnce({ count: 5, paidCount: 3, totalCents: 50000 })
        .mockResolvedValueOnce({ count: 2, paidCount: 2, totalCents: 20000 });

      const result = await service.validateCustomer("cust-uuid-1");

      expect(result.status).toBe("consistent");
      expect(result.discrepancies).toHaveLength(0);
      expect(result.recordsCompared).toBe(7);
      expect(mockCustomersRepository.findById).toHaveBeenCalledWith(
        "cust-uuid-1",
      );
      expect(
        mockInvoicesRepository.getBillingStatsForMigration,
      ).toHaveBeenCalledWith("cust-uuid-1", "monolith_charge_id");
      expect(
        mockInvoicesRepository.getBillingStatsForMigration,
      ).toHaveBeenCalledWith("cust-uuid-1", "monolith_payroll_id");
    });

    it("should detect invoice count mismatch", async () => {
      mockCustomersRepository.findById.mockResolvedValue(mockCustomer);

      // Monolith: 5 charges
      mockMonolithPool.query
        .mockResolvedValueOnce(makeMonolithResult(5, 3, 500))
        .mockResolvedValueOnce(makeMonolithResult(0, 0, 0));

      // Billing: only 3 charge invoices migrated
      mockInvoicesRepository.getBillingStatsForMigration
        .mockResolvedValueOnce({ count: 3, paidCount: 2, totalCents: 30000 })
        .mockResolvedValueOnce({ count: 0, paidCount: 0, totalCents: 0 });

      const result = await service.validateCustomer("cust-uuid-1");

      expect(result.status).toBe("discrepancy_found");
      expect(result.discrepancies.some((d) => d.field === "charge_count")).toBe(
        true,
      );
      const countDisc = result.discrepancies.find(
        (d) => d.field === "charge_count",
      );
      expect(countDisc?.billingServiceValue).toBe(3);
      expect(countDisc?.monolithValue).toBe(5);
    });

    it("should detect amount mismatch (cents vs dollars conversion)", async () => {
      mockCustomersRepository.findById.mockResolvedValue(mockCustomer);

      // Monolith: 1 charge at $100.50
      mockMonolithPool.query
        .mockResolvedValueOnce(makeMonolithResult(1, 1, 100.5))
        .mockResolvedValueOnce(makeMonolithResult(0, 0, 0));

      // Billing: 1 invoice at 9000 cents (should be 10050)
      mockInvoicesRepository.getBillingStatsForMigration
        .mockResolvedValueOnce({ count: 1, paidCount: 1, totalCents: 9000 })
        .mockResolvedValueOnce({ count: 0, paidCount: 0, totalCents: 0 });

      const result = await service.validateCustomer("cust-uuid-1");

      expect(result.status).toBe("discrepancy_found");
      expect(
        result.discrepancies.some((d) => d.field === "charge_total_amount"),
      ).toBe(true);
    });

    it("should allow 1 cent tolerance in amount comparison", async () => {
      mockCustomersRepository.findById.mockResolvedValue(mockCustomer);

      // Monolith: $100.005 (rounds to 10001 cents)
      mockMonolithPool.query
        .mockResolvedValueOnce(makeMonolithResult(1, 1, 100.005))
        .mockResolvedValueOnce(makeMonolithResult(0, 0, 0));

      // Billing: 10000 cents (1 cent difference, within tolerance)
      mockInvoicesRepository.getBillingStatsForMigration
        .mockResolvedValueOnce({ count: 1, paidCount: 1, totalCents: 10000 })
        .mockResolvedValueOnce({ count: 0, paidCount: 0, totalCents: 0 });

      const result = await service.validateCustomer("cust-uuid-1");

      expect(result.status).toBe("consistent");
      expect(result.discrepancies).toHaveLength(0);
    });

    it("should detect paid count mismatch", async () => {
      mockCustomersRepository.findById.mockResolvedValue(mockCustomer);

      // Monolith: 5 charges, 4 paid
      mockMonolithPool.query
        .mockResolvedValueOnce(makeMonolithResult(5, 4, 500))
        .mockResolvedValueOnce(makeMonolithResult(0, 0, 0));

      // Billing: 5 invoices, only 2 paid
      mockInvoicesRepository.getBillingStatsForMigration
        .mockResolvedValueOnce({ count: 5, paidCount: 2, totalCents: 50000 })
        .mockResolvedValueOnce({ count: 0, paidCount: 0, totalCents: 0 });

      const result = await service.validateCustomer("cust-uuid-1");

      expect(result.status).toBe("discrepancy_found");
      expect(result.discrepancies.some((d) => d.field === "paid_count")).toBe(
        true,
      );
    });

    it("should handle customer not found in billing DB", async () => {
      mockCustomersRepository.findById.mockResolvedValue(null);

      const result = await service.validateCustomer("cust-unknown");

      expect(result.status).toBe("error");
      expect(result.error).toBe("customer_not_found_in_billing");
      expect(mockMonolithPool.query).not.toHaveBeenCalled();
    });

    it("should handle monolith query failure gracefully", async () => {
      mockCustomersRepository.findById.mockResolvedValue(mockCustomer);
      mockMonolithPool.query.mockRejectedValue(new Error("Connection refused"));

      const result = await service.validateCustomer("cust-uuid-1");

      expect(result.status).toBe("error");
      expect(result.error).toBe("Connection refused");
    });
  });

  describe("validateCustomer with null monolith pool", () => {
    it("should return error when monolith pool is null", async () => {
      const serviceNoMonolith = new MigrationValidationService(
        mockCustomersRepository as unknown as CustomersRepository,
        mockInvoicesRepository as unknown as InvoicesRepository,
        null,
        mockReconciliationService as unknown as ReconciliationService,
      );

      const result = await serviceNoMonolith.validateCustomer("cust-uuid-1");

      expect(result.status).toBe("error");
      expect(result.error).toBe("monolith_db_unavailable");
    });
  });

  describe("validateWave", () => {
    it("should validate all customers and return aggregate results", async () => {
      // First customer: consistent
      mockCustomersRepository.findById
        .mockResolvedValueOnce(mockCustomer)
        .mockResolvedValueOnce({
          id: "cust-uuid-2",
          monolithCustomerId: "MONO-002",
        });

      // Customer 1: matching
      mockMonolithPool.query
        .mockResolvedValueOnce(makeMonolithResult(3, 3, 300))
        .mockResolvedValueOnce(makeMonolithResult(0, 0, 0));
      mockInvoicesRepository.getBillingStatsForMigration
        .mockResolvedValueOnce({ count: 3, paidCount: 3, totalCents: 30000 })
        .mockResolvedValueOnce({ count: 0, paidCount: 0, totalCents: 0 });

      // Customer 2: mismatch
      mockMonolithPool.query
        .mockResolvedValueOnce(makeMonolithResult(5, 5, 500))
        .mockResolvedValueOnce(makeMonolithResult(0, 0, 0));
      mockInvoicesRepository.getBillingStatsForMigration
        .mockResolvedValueOnce({ count: 3, paidCount: 3, totalCents: 30000 })
        .mockResolvedValueOnce({ count: 0, paidCount: 0, totalCents: 0 });

      const result = await service.validateWave(["cust-uuid-1", "cust-uuid-2"]);

      expect(result.waveSize).toBe(2);
      expect(result.consistent).toBe(1);
      expect(result.discrepancyFound).toBe(1);
      expect(result.customerResults).toHaveLength(2);
      expect(result.totalDiscrepancies).toBeGreaterThan(0);
    });

    it("should handle empty wave", async () => {
      const result = await service.validateWave([]);

      expect(result.waveSize).toBe(0);
      expect(result.consistent).toBe(0);
      expect(result.discrepancyFound).toBe(0);
      expect(result.customerResults).toHaveLength(0);
    });
  });

  describe("runMigrationReconciliation", () => {
    it("should delegate to ReconciliationService", async () => {
      const mockRun = {
        id: "recon-1",
        status: "balanced",
        recordsCompared: 10,
      };
      mockReconciliationService.runDailyReconciliation.mockResolvedValue(
        mockRun,
      );

      const start = new Date("2026-01-01");
      const end = new Date("2026-01-31");

      const result = await service.runMigrationReconciliation(
        start,
        end,
        "corr-recon-1",
      );

      expect(result).toEqual(mockRun);
      expect(
        mockReconciliationService.runDailyReconciliation,
      ).toHaveBeenCalledWith(start, end, "corr-recon-1");
    });
  });
});
