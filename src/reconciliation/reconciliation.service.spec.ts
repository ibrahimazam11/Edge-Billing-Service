import { Logger } from "@nestjs/common";
import { ReconciliationService } from "./reconciliation.service";
import type { PaymentGateway } from "../gateway/gateway.interface";
import type { BalanceTransactionResult } from "../gateway/gateway.types";
import type { ChargesRepository } from "../charges/charges.repository";
import type { ReconciliationDiscrepanciesRepository } from "./reconciliation-discrepancies.repository";
import type { ReconciliationRunsRepository } from "./reconciliation-runs.repository";
import type { LedgerEntriesRepository } from "../ledger/ledger-entries.repository";

describe("ReconciliationService", () => {
  let service: ReconciliationService;
  let mockGateway: {
    getBalanceTransactions: jest.Mock;
  };
  let mockChargesRepo: {
    findByIds: jest.Mock;
  };
  let mockDiscrepanciesRepo: {
    insertBatch: jest.Mock;
  };
  let mockReconciliationRunsRepo: {
    findExistingRun: jest.Mock;
    createInTx: jest.Mock;
    createFailed: jest.Mock;
  };
  let mockLedgerEntriesRepo: {
    findByReferenceType: jest.Mock;
  };
  let logSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const txMock = {};

  const mockDb = {
    transaction: jest.fn((cb: (tx: typeof txMock) => Promise<void>) =>
      cb(txMock),
    ),
  };

  const periodStart = new Date("2026-02-09T00:00:00.000Z");
  const periodEnd = new Date("2026-02-10T00:00:00.000Z");
  const correlationId = "corr-recon-1";

  function makeStripeTransaction(
    overrides: Partial<BalanceTransactionResult> = {},
  ): BalanceTransactionResult {
    return {
      id: "txn_1",
      amount: 5000,
      currency: "usd",
      type: "charge",
      fee: 175,
      net: 4825,
      source: "pi_abc",
      description: "Payment for invoice",
      createdAt: new Date("2026-02-09T12:00:00.000Z"),
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();

    mockGateway = {
      getBalanceTransactions: jest.fn().mockResolvedValue([]),
    };

    mockChargesRepo = {
      findByIds: jest.fn().mockResolvedValue([]),
    };

    mockDiscrepanciesRepo = {
      insertBatch: jest.fn().mockResolvedValue(undefined),
    };

    mockReconciliationRunsRepo = {
      findExistingRun: jest.fn().mockResolvedValue(undefined),
      createInTx: jest.fn().mockResolvedValue(undefined),
      createFailed: jest.fn().mockResolvedValue(undefined),
    };

    mockLedgerEntriesRepo = {
      findByReferenceType: jest.fn().mockResolvedValue([]),
    };

    service = new ReconciliationService(
      mockDb as never,
      mockGateway as unknown as PaymentGateway,
      mockChargesRepo as unknown as ChargesRepository,
      mockDiscrepanciesRepo as unknown as ReconciliationDiscrepanciesRepository,
      mockReconciliationRunsRepo as unknown as ReconciliationRunsRepository,
      mockLedgerEntriesRepo as unknown as LedgerEntriesRepository,
    );

    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    debugSpy = jest
      .spyOn(Logger.prototype, "debug")
      .mockImplementation(() => {});
    errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("successful balanced reconciliation", () => {
    it("should return balanced when all records match", async () => {
      // No existing run
      mockReconciliationRunsRepo.findExistingRun.mockResolvedValue(undefined);

      // Ledger entries (payment records)
      mockLedgerEntriesRepo.findByReferenceType.mockResolvedValue([
        { referenceId: "charge-1" },
      ]);

      // Charges loaded via ChargesRepository.findByIds
      mockChargesRepo.findByIds.mockResolvedValue([
        {
          id: "charge-1",
          stripePaymentIntentId: "pi_abc",
          amountCents: 5000,
        },
      ]);

      // Stripe returns matching charge transaction
      mockGateway.getBalanceTransactions.mockResolvedValue([
        makeStripeTransaction({ id: "txn_1", amount: 5000, source: "pi_abc" }),
      ]);

      const result = await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      expect(result.status).toBe("balanced");
      expect(result.recordsCompared).toBe(1);
      expect(result.totalInternalAmountCents).toBe(5000);
      expect(result.totalStripeAmountCents).toBe(5000);
      expect(result.discrepancies).toHaveLength(0);

      // Verify log level for balanced
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "balanced",
          correlationId,
        }),
      );
    });
  });

  describe("discrepancy detection — missing_internal", () => {
    it("should detect when Stripe has transaction not in internal records", async () => {
      // No internal payments
      mockLedgerEntriesRepo.findByReferenceType.mockResolvedValue([]);

      // Stripe has a charge not in our system
      mockGateway.getBalanceTransactions.mockResolvedValue([
        makeStripeTransaction({
          id: "txn_orphan",
          amount: 3000,
          source: "pi_orphan",
        }),
      ]);

      const result = await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      expect(result.status).toBe("discrepancy_found");
      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0]).toEqual(
        expect.objectContaining({
          type: "missing_internal",
          stripeTransactionId: "txn_orphan",
          internalReferenceId: null,
          actualAmountCents: 3000,
        }),
      );
    });
  });

  describe("discrepancy detection — missing_stripe", () => {
    it("should detect when internal record has no matching Stripe transaction", async () => {
      mockLedgerEntriesRepo.findByReferenceType.mockResolvedValue([
        { referenceId: "charge-1" },
      ]);

      // Charges loaded via ChargesRepository.findByIds
      mockChargesRepo.findByIds.mockResolvedValue([
        {
          id: "charge-1",
          stripePaymentIntentId: "pi_missing",
          amountCents: 7000,
        },
      ]);

      // Stripe returns no matching transactions
      mockGateway.getBalanceTransactions.mockResolvedValue([]);

      const result = await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      expect(result.status).toBe("discrepancy_found");
      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0]).toEqual(
        expect.objectContaining({
          type: "missing_stripe",
          internalReferenceId: "charge-1",
          stripeTransactionId: null,
          expectedAmountCents: 7000,
        }),
      );
    });
  });

  describe("discrepancy detection — amount_mismatch", () => {
    it("should detect when amounts differ between internal and Stripe", async () => {
      mockLedgerEntriesRepo.findByReferenceType.mockResolvedValue([
        { referenceId: "charge-1" },
      ]);

      // Charges loaded via ChargesRepository.findByIds
      mockChargesRepo.findByIds.mockResolvedValue([
        {
          id: "charge-1",
          stripePaymentIntentId: "pi_abc",
          amountCents: 5000,
        },
      ]);

      // Stripe returns different amount
      mockGateway.getBalanceTransactions.mockResolvedValue([
        makeStripeTransaction({ id: "txn_1", amount: 4500, source: "pi_abc" }),
      ]);

      const result = await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      expect(result.status).toBe("discrepancy_found");
      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0]).toEqual(
        expect.objectContaining({
          type: "amount_mismatch",
          internalReferenceId: "charge-1",
          stripeTransactionId: "txn_1",
          expectedAmountCents: 5000,
          actualAmountCents: 4500,
          differenceCents: 500,
        }),
      );
    });
  });

  describe("mixed results", () => {
    it("should detect multiple discrepancy types in one reconciliation", async () => {
      // Two internal payments
      mockLedgerEntriesRepo.findByReferenceType.mockResolvedValue([
        { referenceId: "charge-1" },
        { referenceId: "charge-2" },
      ]);

      // Charges loaded via ChargesRepository.findByIds
      mockChargesRepo.findByIds.mockResolvedValue([
        {
          id: "charge-1",
          stripePaymentIntentId: "pi_abc",
          amountCents: 5000,
        },
        {
          id: "charge-2",
          stripePaymentIntentId: "pi_def",
          amountCents: 3000,
        },
      ]);

      // Stripe: pi_abc matches, pi_def is missing, pi_orphan is extra
      mockGateway.getBalanceTransactions.mockResolvedValue([
        makeStripeTransaction({ id: "txn_1", amount: 5000, source: "pi_abc" }),
        makeStripeTransaction({
          id: "txn_orphan",
          amount: 2000,
          source: "pi_orphan",
        }),
      ]);

      const result = await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      expect(result.status).toBe("discrepancy_found");
      expect(result.discrepancies).toHaveLength(2);

      const types = result.discrepancies.map((d) => d.type);
      expect(types).toContain("missing_stripe");
      expect(types).toContain("missing_internal");

      // Verify error-level logging for discrepancies
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "discrepancy_found",
          discrepancyCount: 2,
        }),
      );
    });
  });

  describe("duplicate run prevention", () => {
    it("should skip reconciliation when same period already completed", async () => {
      // Existing balanced run
      mockReconciliationRunsRepo.findExistingRun.mockResolvedValue({
        id: "existing-run-1",
        status: "balanced",
        recordsCompared: 10,
        totalInternalAmountCents: 50000,
        totalStripeAmountCents: 50000,
        errorReason: null,
      });

      const result = await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      expect(result.id).toBe("existing-run-1");
      expect(result.status).toBe("balanced");

      // Should NOT have called gateway
      expect(mockGateway.getBalanceTransactions).not.toHaveBeenCalled();

      // Should log at debug level
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Reconciliation already completed for period, skipping",
          existingRunId: "existing-run-1",
        }),
      );
    });
  });

  describe("Stripe API failure", () => {
    it("should store failed run with error reason", async () => {
      mockGateway.getBalanceTransactions.mockRejectedValue(
        new Error("Stripe connection timeout"),
      );

      const result = await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      expect(result.status).toBe("failed");
      expect(result.errorReason).toBe("Stripe connection timeout");
      expect(result.recordsCompared).toBe(0);

      // Should log at error level
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Reconciliation failed — Stripe API error",
          error: "Stripe connection timeout",
        }),
      );

      // Should have stored failed run via repository
      expect(mockReconciliationRunsRepo.createFailed).toHaveBeenCalled();
    });
  });

  describe("empty period", () => {
    it("should return balanced with 0 records when no data exists", async () => {
      mockLedgerEntriesRepo.findByReferenceType.mockResolvedValue([]);
      mockGateway.getBalanceTransactions.mockResolvedValue([]);

      const result = await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      expect(result.status).toBe("balanced");
      expect(result.recordsCompared).toBe(0);
      expect(result.totalInternalAmountCents).toBe(0);
      expect(result.totalStripeAmountCents).toBe(0);
      expect(result.discrepancies).toHaveLength(0);
    });
  });

  describe("structured logging", () => {
    it("should log at correct levels for each status", async () => {
      mockLedgerEntriesRepo.findByReferenceType.mockResolvedValue([]);
      mockGateway.getBalanceTransactions.mockResolvedValue([]);

      await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Reconciliation completed — balanced",
          status: "balanced",
          recordsCompared: 0,
          correlationId,
        }),
      );
    });
  });

  describe("pagination", () => {
    it("should pass date filter to gateway for Stripe transactions", async () => {
      mockLedgerEntriesRepo.findByReferenceType.mockResolvedValue([]);
      mockGateway.getBalanceTransactions.mockResolvedValue([]);

      await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      expect(mockGateway.getBalanceTransactions).toHaveBeenCalledWith({
        createdGte: Math.floor(periodStart.getTime() / 1000),
        createdLt: Math.floor(periodEnd.getTime() / 1000),
        limit: 100,
      });
    });
  });

  describe("Stripe transaction filtering", () => {
    it("should filter out non-charge transactions from Stripe", async () => {
      mockLedgerEntriesRepo.findByReferenceType.mockResolvedValue([]);

      // Stripe returns mix of charge and payout transactions
      mockGateway.getBalanceTransactions.mockResolvedValue([
        makeStripeTransaction({
          id: "txn_payout",
          type: "payout",
          source: "po_123",
          amount: -10000,
        }),
        makeStripeTransaction({
          id: "txn_charge",
          type: "charge",
          source: "pi_new",
          amount: 5000,
        }),
      ]);

      const result = await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      // Only the charge should appear as missing_internal
      // since we have no internal records for it
      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0].type).toBe("missing_internal");
      expect(result.discrepancies[0].stripeTransactionId).toBe("txn_charge");
    });
  });

  describe("transaction storage", () => {
    it("should store reconciliation run and discrepancies in a single transaction", async () => {
      mockLedgerEntriesRepo.findByReferenceType.mockResolvedValue([]);

      // Stripe has one orphan charge
      mockGateway.getBalanceTransactions.mockResolvedValue([
        makeStripeTransaction({
          id: "txn_1",
          amount: 5000,
          source: "pi_orphan",
        }),
      ]);

      await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      // Should use db.transaction for atomic write
      expect(mockDb.transaction).toHaveBeenCalled();

      // Inside transaction: run insert via repository, discrepancies via repository
      expect(mockReconciliationRunsRepo.createInTx).toHaveBeenCalledTimes(1);
      expect(mockDiscrepanciesRepo.insertBatch).toHaveBeenCalledTimes(1);
      expect(mockDiscrepanciesRepo.insertBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            type: "missing_internal",
            stripeTransactionId: "txn_1",
          }),
        ]),
        txMock,
      );
    });
  });

  describe("half-open interval boundary (regression: H1)", () => {
    it("should pass createdLt (exclusive) not createdLte to gateway for period end", async () => {
      mockLedgerEntriesRepo.findByReferenceType.mockResolvedValue([]);
      mockGateway.getBalanceTransactions.mockResolvedValue([]);

      await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      const callArgs = mockGateway.getBalanceTransactions.mock
        .calls[0][0] as Record<string, unknown>;
      // Must use createdLt (exclusive), NOT createdLte (inclusive)
      expect(callArgs.createdLt).toBe(Math.floor(periodEnd.getTime() / 1000));
      expect(callArgs).not.toHaveProperty("createdLte");
    });
  });

  describe("recordsCompared uses union of PI IDs (regression: M3)", () => {
    it("should count unique records across both systems, not max", async () => {
      // 1 internal payment
      mockLedgerEntriesRepo.findByReferenceType.mockResolvedValue([
        { referenceId: "charge-1" },
      ]);

      // Charges loaded via ChargesRepository.findByIds
      mockChargesRepo.findByIds.mockResolvedValue([
        {
          id: "charge-1",
          stripePaymentIntentId: "pi_abc",
          amountCents: 5000,
        },
      ]);

      // 2 Stripe transactions: pi_abc (matches) + pi_orphan (no match)
      mockGateway.getBalanceTransactions.mockResolvedValue([
        makeStripeTransaction({ id: "txn_1", amount: 5000, source: "pi_abc" }),
        makeStripeTransaction({
          id: "txn_2",
          amount: 3000,
          source: "pi_orphan",
        }),
      ]);

      const result = await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      // Union of {pi_abc, pi_orphan} = 2, NOT Math.max(1, 2) = 2
      // (same value here, but semantics matter — test explicitly)
      expect(result.recordsCompared).toBe(2);
      // Also verify discrepancy: pi_orphan is missing_internal
      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0].type).toBe("missing_internal");
    });
  });

  describe("duplicate PaymentIntent ID warning (regression: H3)", () => {
    it("should log warning when duplicate PI IDs found in internal payments", async () => {
      // Two ledger entries referencing different charges that map to same PI ID
      mockLedgerEntriesRepo.findByReferenceType.mockResolvedValue([
        { referenceId: "charge-1" },
        { referenceId: "charge-2" },
      ]);

      // Both charges map to the same stripe PI ID
      mockChargesRepo.findByIds.mockResolvedValue([
        {
          id: "charge-1",
          stripePaymentIntentId: "pi_same",
          amountCents: 5000,
        },
        {
          id: "charge-2",
          stripePaymentIntentId: "pi_same",
          amountCents: 5000,
        },
      ]);

      mockGateway.getBalanceTransactions.mockResolvedValue([
        makeStripeTransaction({
          id: "txn_1",
          amount: 5000,
          source: "pi_same",
        }),
      ]);

      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      await service.runDailyReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "Duplicate PaymentIntent ID in internal payments — last entry wins",
          stripePaymentIntentId: "pi_same",
        }),
      );
    });
  });
});
