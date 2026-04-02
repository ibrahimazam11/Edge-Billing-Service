import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ReportingService } from "./reporting.service";
import { SubscriptionsRepository } from "../subscriptions/subscriptions.repository";
import { LedgerEntriesRepository } from "../ledger/ledger-entries.repository";
import { ChargesRepository } from "../charges/charges.repository";
import { DunningAttemptsRepository } from "../dunning/dunning.repository";
import { ReconciliationRunsRepository } from "../reconciliation/reconciliation-runs.repository";
import { ReconciliationDiscrepanciesRepository } from "../reconciliation/reconciliation-discrepancies.repository";

describe("ReportingService", () => {
  let service: ReportingService;

  const subscriptionsRepo = {
    getActiveMetrics: jest.fn(),
  };

  const ledgerEntriesRepo = {
    aggregateRevenueByDateRange: jest.fn(),
  };

  const chargesRepo = {
    aggregateSuccessRateByDateRange: jest.fn(),
  };

  const dunningAttemptsRepo = {
    aggregateDunningByDateRange: jest.fn(),
    aggregateEscalatedByDateRange: jest.fn(),
    aggregateRecoveryByAttempt: jest.fn(),
    aggregateDunningStats: jest.fn(),
  };

  const reconciliationRunsRepo = {
    findByDateRange: jest.fn(),
    getLatestRunStatus: jest.fn(),
  };

  const discrepanciesRepo = {
    findByRunIds: jest.fn(),
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ReportingService,
        { provide: SubscriptionsRepository, useValue: subscriptionsRepo },
        { provide: LedgerEntriesRepository, useValue: ledgerEntriesRepo },
        { provide: ChargesRepository, useValue: chargesRepo },
        { provide: DunningAttemptsRepository, useValue: dunningAttemptsRepo },
        {
          provide: ReconciliationRunsRepository,
          useValue: reconciliationRunsRepo,
        },
        {
          provide: ReconciliationDiscrepanciesRepository,
          useValue: discrepanciesRepo,
        },
      ],
    }).compile();

    service = module.get<ReportingService>(ReportingService);

    jest.clearAllMocks();
  });

  describe("getRevenueReport", () => {
    it("should return correct sums for mixed ledger entries", async () => {
      ledgerEntriesRepo.aggregateRevenueByDateRange.mockResolvedValueOnce({
        totalInvoiced: 50000,
        totalCollected: 30000,
        totalWriteOff: 5000,
        totalCreditsIssued: 2000,
      });

      const result = await service.getRevenueReport("2026-01-01", "2026-02-01");

      expect(result.totalInvoiced).toBe(50000);
      expect(result.totalCollected).toBe(30000);
      expect(result.totalWriteOff).toBe(5000);
      expect(result.totalCreditsIssued).toBe(2000);
      expect(result.currency).toBe("usd");
      expect(result.periodStart).toBe("2026-01-01");
      expect(result.periodEnd).toBe("2026-02-01");
    });

    it("should return all zeros for empty period", async () => {
      ledgerEntriesRepo.aggregateRevenueByDateRange.mockResolvedValueOnce({
        totalInvoiced: 0,
        totalCollected: 0,
        totalWriteOff: 0,
        totalCreditsIssued: 0,
      });

      const result = await service.getRevenueReport("2026-06-01", "2026-07-01");

      expect(result.totalInvoiced).toBe(0);
      expect(result.totalCollected).toBe(0);
      expect(result.totalOutstanding).toBe(0);
      expect(result.totalWriteOff).toBe(0);
      expect(result.totalCreditsIssued).toBe(0);
      expect(result.netRevenue).toBe(0);
    });

    it("should calculate derived fields correctly", async () => {
      ledgerEntriesRepo.aggregateRevenueByDateRange.mockResolvedValueOnce({
        totalInvoiced: 100000,
        totalCollected: 60000,
        totalWriteOff: 10000,
        totalCreditsIssued: 5000,
      });

      const result = await service.getRevenueReport("2026-01-01", "2026-02-01");

      // totalOutstanding = 100000 - 60000 - 10000 - 5000 = 25000
      expect(result.totalOutstanding).toBe(25000);
      // netRevenue = 60000 - 10000 = 50000
      expect(result.netRevenue).toBe(50000);
    });

    it("should reject startDate >= endDate", async () => {
      await expect(
        service.getRevenueReport("2026-02-01", "2026-01-01"),
      ).rejects.toThrow(BadRequestException);

      expect(
        ledgerEntriesRepo.aggregateRevenueByDateRange,
      ).not.toHaveBeenCalled();
    });

    it("should call ledgerEntriesRepository.aggregateRevenueByDateRange with Date objects", async () => {
      ledgerEntriesRepo.aggregateRevenueByDateRange.mockResolvedValueOnce({
        totalInvoiced: 0,
        totalCollected: 0,
        totalWriteOff: 0,
        totalCreditsIssued: 0,
      });

      await service.getRevenueReport("2026-01-01", "2026-02-01");

      expect(
        ledgerEntriesRepo.aggregateRevenueByDateRange,
      ).toHaveBeenCalledTimes(1);
      expect(
        ledgerEntriesRepo.aggregateRevenueByDateRange,
      ).toHaveBeenCalledWith(new Date("2026-01-01"), new Date("2026-02-01"));
    });
  });

  describe("getReconciliationReport", () => {
    const mockRun = {
      id: "r0000000-0000-4000-a000-000000000001",
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2026-01-02T00:00:00Z"),
      status: "balanced" as const,
      recordsCompared: 42,
      totalInternalAmountCents: 100000,
      totalStripeAmountCents: 100000,
      errorReason: null,
      correlationId: null,
      createdAt: new Date("2026-01-02T12:00:00Z"),
    };

    it("should return paginated runs with discrepancies", async () => {
      reconciliationRunsRepo.findByDateRange.mockResolvedValueOnce([mockRun]);
      discrepanciesRepo.findByRunIds.mockResolvedValueOnce([]);

      const result = await service.getReconciliationReport({ limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe(mockRun.id);
      expect(result.data[0].status).toBe("balanced");
      expect(result.data[0].discrepancies).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it("should filter by status", async () => {
      reconciliationRunsRepo.findByDateRange.mockResolvedValueOnce([]);

      await service.getReconciliationReport({
        status: "discrepancy_found",
        limit: 20,
      });

      expect(reconciliationRunsRepo.findByDateRange).toHaveBeenCalledWith(
        expect.objectContaining({ status: "discrepancy_found" }),
        20,
      );
    });

    it("should filter by date range", async () => {
      reconciliationRunsRepo.findByDateRange.mockResolvedValueOnce([]);

      await service.getReconciliationReport({
        startDate: "2026-01-01",
        endDate: "2026-02-01",
        limit: 20,
      });

      expect(reconciliationRunsRepo.findByDateRange).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: "2026-01-01",
          endDate: "2026-02-01",
        }),
        20,
      );
    });

    it("should implement cursor-based pagination", async () => {
      const runs = Array.from({ length: 21 }, (_, i) => ({
        ...mockRun,
        id: `r0000000-0000-4000-a000-${String(i + 1).padStart(12, "0")}`,
      }));

      reconciliationRunsRepo.findByDateRange.mockResolvedValueOnce(runs);
      discrepanciesRepo.findByRunIds.mockResolvedValueOnce([]);

      const result = await service.getReconciliationReport({ limit: 20 });

      expect(result.data).toHaveLength(20);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe("r0000000-0000-4000-a000-000000000020");
    });

    it("should reject startDate >= endDate when both provided", async () => {
      await expect(
        service.getReconciliationReport({
          startDate: "2026-02-01",
          endDate: "2026-01-01",
          limit: 20,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should return empty page when no data", async () => {
      reconciliationRunsRepo.findByDateRange.mockResolvedValueOnce([]);

      const result = await service.getReconciliationReport({ limit: 20 });

      expect(result.data).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
    });

    it("should batch-load discrepancies (no N+1)", async () => {
      const run1 = {
        ...mockRun,
        id: "r0000000-0000-4000-a000-000000000001",
        status: "discrepancy_found" as const,
      };
      const run2 = {
        ...mockRun,
        id: "r0000000-0000-4000-a000-000000000002",
        status: "discrepancy_found" as const,
      };

      reconciliationRunsRepo.findByDateRange.mockResolvedValueOnce([
        run1,
        run2,
      ]);
      discrepanciesRepo.findByRunIds.mockResolvedValueOnce([
        {
          id: "d0000000-0000-4000-a000-000000000001",
          reconciliationRunId: run1.id,
          type: "amount_mismatch",
          internalReferenceId: "int-1",
          stripeTransactionId: "txn_1",
          expectedAmountCents: 5000,
          actualAmountCents: 4500,
          differenceCents: 500,
          createdAt: new Date(),
        },
        {
          id: "d0000000-0000-4000-a000-000000000002",
          reconciliationRunId: run2.id,
          type: "missing_stripe",
          internalReferenceId: "int-2",
          stripeTransactionId: null,
          expectedAmountCents: 3000,
          actualAmountCents: 0,
          differenceCents: 3000,
          createdAt: new Date(),
        },
      ]);

      const result = await service.getReconciliationReport({ limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.data[0].discrepancies).toHaveLength(1);
      expect(result.data[1].discrepancies).toHaveLength(1);
      // Only 1 discrepancy query (batch) — no N+1
      expect(discrepanciesRepo.findByRunIds).toHaveBeenCalledTimes(1);
      expect(discrepanciesRepo.findByRunIds).toHaveBeenCalledWith([
        run1.id,
        run2.id,
      ]);
    });
  });

  describe("getDunningReport", () => {
    function mockDunningRepos(
      main: {
        totalInvoicesInDunning: number;
        recoveredCount: number;
        recoveredAmountCents: number;
        avgRecoveryAttempts: number;
      },
      escalated: { escalatedCount: number; escalatedAmountCents: number },
      byAttempt: { attemptNumber: number; count: number }[],
    ): void {
      dunningAttemptsRepo.aggregateDunningByDateRange.mockResolvedValueOnce(
        main,
      );
      dunningAttemptsRepo.aggregateEscalatedByDateRange.mockResolvedValueOnce(
        escalated,
      );
      dunningAttemptsRepo.aggregateRecoveryByAttempt.mockResolvedValueOnce(
        byAttempt,
      );
    }

    it("should return correct aggregations for mixed attempt statuses", async () => {
      mockDunningRepos(
        {
          totalInvoicesInDunning: 5,
          recoveredCount: 3,
          recoveredAmountCents: 30000,
          avgRecoveryAttempts: 1.67,
        },
        { escalatedCount: 1, escalatedAmountCents: 10000 },
        [
          { attemptNumber: 1, count: 2 },
          { attemptNumber: 2, count: 1 },
        ],
      );

      const result = await service.getDunningReport("2026-01-01", "2026-02-01");

      expect(result.totalInvoicesInDunning).toBe(5);
      expect(result.totalRecovered.count).toBe(3);
      expect(result.totalRecovered.amountCents).toBe(30000);
      expect(result.totalEscalated.count).toBe(1);
      expect(result.totalEscalated.amountCents).toBe(10000);
      expect(result.recoveryRate).toBe(60);
      expect(result.averageRecoveryAttempts).toBe(1.67);
      expect(result.recoveryByAttempt).toEqual([
        { attemptNumber: 1, count: 2 },
        { attemptNumber: 2, count: 1 },
      ]);
      expect(result.periodStart).toBe("2026-01-01");
      expect(result.periodEnd).toBe("2026-02-01");
    });

    it("should return all zeros when no dunning data exists", async () => {
      mockDunningRepos(
        {
          totalInvoicesInDunning: 0,
          recoveredCount: 0,
          recoveredAmountCents: 0,
          avgRecoveryAttempts: 0,
        },
        { escalatedCount: 0, escalatedAmountCents: 0 },
        [],
      );

      const result = await service.getDunningReport("2026-01-01", "2026-02-01");

      expect(result.totalInvoicesInDunning).toBe(0);
      expect(result.totalRecovered.count).toBe(0);
      expect(result.totalRecovered.amountCents).toBe(0);
      expect(result.totalEscalated.count).toBe(0);
      expect(result.totalEscalated.amountCents).toBe(0);
      expect(result.recoveryRate).toBe(0);
      expect(result.averageRecoveryAttempts).toBe(0);
      expect(result.recoveryByAttempt).toEqual([]);
    });

    it("should default to current month when no dates provided", async () => {
      mockDunningRepos(
        {
          totalInvoicesInDunning: 0,
          recoveredCount: 0,
          recoveredAmountCents: 0,
          avgRecoveryAttempts: 0,
        },
        { escalatedCount: 0, escalatedAmountCents: 0 },
        [],
      );

      const result = await service.getDunningReport();

      // Should have ISO string period boundaries for current month
      expect(result.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
      expect(result.periodEnd).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
      // periodStart should be the 1st of current month
      const now = new Date();
      const expectedStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      expect(result.periodStart).toBe(expectedStart.toISOString());
    });

    it("should validate inverted date range (throws BadRequestException)", async () => {
      await expect(
        service.getDunningReport("2026-02-01", "2026-01-01"),
      ).rejects.toThrow(BadRequestException);

      expect(
        dunningAttemptsRepo.aggregateDunningByDateRange,
      ).not.toHaveBeenCalled();
    });

    it("should reject when only startDate is provided (partial dates)", async () => {
      await expect(
        service.getDunningReport("2026-01-01", undefined),
      ).rejects.toThrow(BadRequestException);

      expect(
        dunningAttemptsRepo.aggregateDunningByDateRange,
      ).not.toHaveBeenCalled();
    });

    it("should reject when only endDate is provided (partial dates)", async () => {
      await expect(
        service.getDunningReport(undefined, "2026-02-01"),
      ).rejects.toThrow(BadRequestException);

      expect(
        dunningAttemptsRepo.aggregateDunningByDateRange,
      ).not.toHaveBeenCalled();
    });

    it("should calculate recoveryRate correctly (recovered/total * 100)", async () => {
      mockDunningRepos(
        {
          totalInvoicesInDunning: 10,
          recoveredCount: 9,
          recoveredAmountCents: 90000,
          avgRecoveryAttempts: 1.2,
        },
        { escalatedCount: 1, escalatedAmountCents: 10000 },
        [{ attemptNumber: 1, count: 9 }],
      );

      const result = await service.getDunningReport("2026-01-01", "2026-02-01");

      expect(result.recoveryRate).toBe(90);
    });

    it("should calculate averageRecoveryAttempts only from succeeded attempts", async () => {
      mockDunningRepos(
        {
          totalInvoicesInDunning: 4,
          recoveredCount: 2,
          recoveredAmountCents: 20000,
          avgRecoveryAttempts: 2.5,
        },
        { escalatedCount: 1, escalatedAmountCents: 10000 },
        [
          { attemptNumber: 2, count: 1 },
          { attemptNumber: 3, count: 1 },
        ],
      );

      const result = await service.getDunningReport("2026-01-01", "2026-02-01");

      // AVG comes from repo: 2.5
      expect(result.averageRecoveryAttempts).toBe(2.5);
    });

    it("should group recoveryByAttempt correctly by attempt_number", async () => {
      mockDunningRepos(
        {
          totalInvoicesInDunning: 10,
          recoveredCount: 8,
          recoveredAmountCents: 80000,
          avgRecoveryAttempts: 1.5,
        },
        { escalatedCount: 0, escalatedAmountCents: 0 },
        [
          { attemptNumber: 1, count: 5 },
          { attemptNumber: 2, count: 2 },
          { attemptNumber: 3, count: 1 },
        ],
      );

      const result = await service.getDunningReport("2026-01-01", "2026-02-01");

      expect(result.recoveryByAttempt).toHaveLength(3);
      expect(result.recoveryByAttempt[0]).toEqual({
        attemptNumber: 1,
        count: 5,
      });
      expect(result.recoveryByAttempt[1]).toEqual({
        attemptNumber: 2,
        count: 2,
      });
      expect(result.recoveryByAttempt[2]).toEqual({
        attemptNumber: 3,
        count: 1,
      });
    });

    it("should report escalated count excluding invoices with any succeeded attempt", async () => {
      mockDunningRepos(
        {
          totalInvoicesInDunning: 5,
          recoveredCount: 3,
          recoveredAmountCents: 30000,
          avgRecoveryAttempts: 1.33,
        },
        { escalatedCount: 2, escalatedAmountCents: 20000 },
        [{ attemptNumber: 1, count: 3 }],
      );

      const result = await service.getDunningReport("2026-01-01", "2026-02-01");

      expect(result.totalEscalated.count).toBe(2);
      expect(result.totalEscalated.amountCents).toBe(20000);
    });

    it("should delegate to repository methods (no direct db calls)", async () => {
      mockDunningRepos(
        {
          totalInvoicesInDunning: 0,
          recoveredCount: 0,
          recoveredAmountCents: 0,
          avgRecoveryAttempts: 0,
        },
        { escalatedCount: 0, escalatedAmountCents: 0 },
        [],
      );

      await service.getDunningReport("2026-01-01", "2026-02-01");

      expect(
        dunningAttemptsRepo.aggregateDunningByDateRange,
      ).toHaveBeenCalledTimes(1);
      expect(
        dunningAttemptsRepo.aggregateEscalatedByDateRange,
      ).toHaveBeenCalledTimes(1);
      expect(
        dunningAttemptsRepo.aggregateRecoveryByAttempt,
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe("getDashboardReport", () => {
    function mockDashboardRepos(
      subscriptions: { activeCount: number; mrr: number },
      revenue: {
        totalInvoiced: number;
        totalCollected: number;
        totalWriteOff: number;
        totalCreditsIssued: number;
      },
      charges: { totalCharges: number; succeededCharges: number },
      dunning: { totalDunning: number; recovered: number },
      reconStatus: string | null,
    ): void {
      subscriptionsRepo.getActiveMetrics.mockResolvedValueOnce(subscriptions);
      ledgerEntriesRepo.aggregateRevenueByDateRange.mockResolvedValueOnce(
        revenue,
      );
      chargesRepo.aggregateSuccessRateByDateRange.mockResolvedValueOnce(
        charges,
      );
      dunningAttemptsRepo.aggregateDunningStats.mockResolvedValueOnce(dunning);
      reconciliationRunsRepo.getLatestRunStatus.mockResolvedValueOnce(
        reconStatus,
      );
    }

    it("should return correct active subscription count and MRR", async () => {
      mockDashboardRepos(
        { activeCount: 15, mrr: 150000 },
        {
          totalInvoiced: 0,
          totalCollected: 0,
          totalWriteOff: 0,
          totalCreditsIssued: 0,
        },
        { totalCharges: 0, succeededCharges: 0 },
        { totalDunning: 0, recovered: 0 },
        "balanced",
      );

      const result = await service.getDashboardReport();

      expect(result.activeSubscriptions).toBe(15);
      expect(result.monthlyRecurringRevenue).toBe(150000);
    });

    it("should return correct current month revenue figures", async () => {
      mockDashboardRepos(
        { activeCount: 0, mrr: 0 },
        {
          totalInvoiced: 50000,
          totalCollected: 30000,
          totalWriteOff: 5000,
          totalCreditsIssued: 2000,
        },
        { totalCharges: 0, succeededCharges: 0 },
        { totalDunning: 0, recovered: 0 },
        "balanced",
      );

      const result = await service.getDashboardReport();

      expect(result.currentMonthInvoiced).toBe(50000);
      expect(result.currentMonthCollected).toBe(30000);
      // outstanding = 50000 - 30000 - 5000 - 2000 = 13000
      expect(result.currentMonthOutstanding).toBe(13000);
    });

    it("should calculate paymentSuccessRate correctly", async () => {
      mockDashboardRepos(
        { activeCount: 0, mrr: 0 },
        {
          totalInvoiced: 0,
          totalCollected: 0,
          totalWriteOff: 0,
          totalCreditsIssued: 0,
        },
        { totalCharges: 20, succeededCharges: 18 },
        { totalDunning: 0, recovered: 0 },
        "balanced",
      );

      const result = await service.getDashboardReport();

      expect(result.paymentSuccessRate).toBe(90);
    });

    it("should calculate dunningRecoveryRate correctly", async () => {
      mockDashboardRepos(
        { activeCount: 0, mrr: 0 },
        {
          totalInvoiced: 0,
          totalCollected: 0,
          totalWriteOff: 0,
          totalCreditsIssued: 0,
        },
        { totalCharges: 0, succeededCharges: 0 },
        { totalDunning: 10, recovered: 8 },
        "balanced",
      );

      const result = await service.getDashboardReport();

      expect(result.dunningRecoveryRate).toBe(80);
    });

    it("should return latest reconciliation status", async () => {
      mockDashboardRepos(
        { activeCount: 0, mrr: 0 },
        {
          totalInvoiced: 0,
          totalCollected: 0,
          totalWriteOff: 0,
          totalCreditsIssued: 0,
        },
        { totalCharges: 0, succeededCharges: 0 },
        { totalDunning: 0, recovered: 0 },
        "discrepancy_found",
      );

      const result = await service.getDashboardReport();

      expect(result.reconciliationStatus).toBe("discrepancy_found");
    });

    it("should return 'none' when no reconciliation runs exist", async () => {
      mockDashboardRepos(
        { activeCount: 0, mrr: 0 },
        {
          totalInvoiced: 0,
          totalCollected: 0,
          totalWriteOff: 0,
          totalCreditsIssued: 0,
        },
        { totalCharges: 0, succeededCharges: 0 },
        { totalDunning: 0, recovered: 0 },
        null,
      );

      const result = await service.getDashboardReport();

      expect(result.reconciliationStatus).toBe("none");
    });

    it("should return all zeros for fresh system (no data)", async () => {
      mockDashboardRepos(
        { activeCount: 0, mrr: 0 },
        {
          totalInvoiced: 0,
          totalCollected: 0,
          totalWriteOff: 0,
          totalCreditsIssued: 0,
        },
        { totalCharges: 0, succeededCharges: 0 },
        { totalDunning: 0, recovered: 0 },
        null,
      );

      const result = await service.getDashboardReport();

      expect(result.activeSubscriptions).toBe(0);
      expect(result.monthlyRecurringRevenue).toBe(0);
      expect(result.currentMonthInvoiced).toBe(0);
      expect(result.currentMonthCollected).toBe(0);
      expect(result.currentMonthOutstanding).toBe(0);
      expect(result.paymentSuccessRate).toBe(0);
      expect(result.dunningRecoveryRate).toBe(0);
      expect(result.reconciliationStatus).toBe("none");
      expect(result.currency).toBe("usd");
    });

    it("should delegate to 5 repository methods (no direct db calls)", async () => {
      mockDashboardRepos(
        { activeCount: 0, mrr: 0 },
        {
          totalInvoiced: 0,
          totalCollected: 0,
          totalWriteOff: 0,
          totalCreditsIssued: 0,
        },
        { totalCharges: 0, succeededCharges: 0 },
        { totalDunning: 0, recovered: 0 },
        null,
      );

      await service.getDashboardReport();

      expect(subscriptionsRepo.getActiveMetrics).toHaveBeenCalledTimes(1);
      expect(
        ledgerEntriesRepo.aggregateRevenueByDateRange,
      ).toHaveBeenCalledTimes(1);
      expect(chargesRepo.aggregateSuccessRateByDateRange).toHaveBeenCalledTimes(
        1,
      );
      expect(dunningAttemptsRepo.aggregateDunningStats).toHaveBeenCalledTimes(
        1,
      );
      expect(reconciliationRunsRepo.getLatestRunStatus).toHaveBeenCalledTimes(
        1,
      );
    });
  });
});
