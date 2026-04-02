import { Test } from "@nestjs/testing";
import { DunningAttemptsRepository } from "./dunning.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

const executeMock = jest.fn();

const now = new Date("2026-02-10T00:00:00.000Z");

const mockDunningRow = {
  id: "dunning-123",
  invoiceId: "inv-123",
  chargeId: null,
  paymentMethodId: null,
  attemptNumber: 1,
  scheduledDate: now,
  executedAt: null,
  status: "scheduled",
  failureReason: null,
  createdAt: now,
};

describe("DunningAttemptsRepository", () => {
  let repository: DunningAttemptsRepository;
  let selectChain: Record<string, jest.Mock>;
  let insertChain: Record<string, jest.Mock>;
  let updateChain: Record<string, jest.Mock>;
  let mockDb: Record<string, jest.Mock>;

  beforeEach(async () => {
    executeMock.mockClear();

    selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      orderBy: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      then: jest.fn((resolve: (value: unknown[]) => void) => resolve([])),
    };

    insertChain = {
      values: jest.fn().mockResolvedValue(undefined),
    };

    updateChain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    };

    mockDb = {
      select: jest.fn(() => selectChain),
      insert: jest.fn(() => insertChain),
      update: jest.fn(() => updateChain),
      execute: executeMock,
    };

    const module = await Test.createTestingModule({
      providers: [
        DunningAttemptsRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<DunningAttemptsRepository>(
      DunningAttemptsRepository,
    );
  });

  describe("findById", () => {
    it("should return dunning attempt when found", async () => {
      selectChain.limit.mockResolvedValueOnce([mockDunningRow]);

      const result = await repository.findById("dunning-123");

      expect(result).toEqual(mockDunningRow);
      expect(mockDb.select).toHaveBeenCalled();
      expect(selectChain.from).toHaveBeenCalled();
      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });

    it("should return null when not found", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findById("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("findByInvoiceId", () => {
    it("should return attempts ordered by attemptNumber ASC", async () => {
      const rows = [
        { ...mockDunningRow, id: "d-1", attemptNumber: 1 },
        { ...mockDunningRow, id: "d-2", attemptNumber: 2 },
      ];
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve(rows),
      );

      const result = await repository.findByInvoiceId("inv-123");

      expect(result).toEqual(rows);
      expect(result).toHaveLength(2);
      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.orderBy).toHaveBeenCalled();
    });

    it("should return empty array when no attempts exist", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([]),
      );

      const result = await repository.findByInvoiceId("inv-nonexistent");

      expect(result).toEqual([]);
    });
  });

  describe("findScheduled", () => {
    it("should return scheduled attempts with scheduledDate <= now", async () => {
      const rows = [{ ...mockDunningRow, status: "scheduled" }];
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve(rows),
      );

      const result = await repository.findScheduled();

      expect(result).toEqual(rows);
      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.orderBy).toHaveBeenCalled();
    });

    it("should return empty array when no scheduled attempts are due", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([]),
      );

      const result = await repository.findScheduled();

      expect(result).toEqual([]);
    });
  });

  describe("findExistingNonSkipped", () => {
    it("should return non-skipped attempts for invoice", async () => {
      const rows = [
        { ...mockDunningRow, status: "scheduled" },
        { ...mockDunningRow, id: "d-2", status: "failed" },
      ];
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve(rows),
      );

      const result = await repository.findExistingNonSkipped("inv-123");

      expect(result).toEqual(rows);
      expect(result).toHaveLength(2);
      expect(selectChain.where).toHaveBeenCalled();
    });

    it("should return empty array when all attempts are skipped", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([]),
      );

      const result = await repository.findExistingNonSkipped("inv-123");

      expect(result).toEqual([]);
    });
  });

  describe("insert", () => {
    it("should insert dunning attempt using db when no tx provided", async () => {
      const data = {
        id: "dunning-new",
        invoiceId: "inv-123",
        attemptNumber: 1,
        scheduledDate: now,
        status: "scheduled",
      };

      await repository.insert(data);

      expect(mockDb.insert).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(data);
    });

    it("should insert dunning attempt using tx when provided", async () => {
      const txInsertChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };
      const txMock = {
        insert: jest.fn(() => txInsertChain),
      };

      const data = {
        id: "dunning-new",
        invoiceId: "inv-123",
        attemptNumber: 1,
        scheduledDate: now,
        status: "scheduled",
      };

      await repository.insert(data, txMock as never);

      expect(txMock.insert).toHaveBeenCalled();
      expect(txInsertChain.values).toHaveBeenCalledWith(data);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("updateStatus", () => {
    it("should update dunning attempt status", async () => {
      await repository.updateStatus("dunning-123", {
        status: "succeeded",
        executedAt: now,
        chargeId: "charge-1",
      });

      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith({
        status: "succeeded",
        executedAt: now,
        chargeId: "charge-1",
      });
      expect(updateChain.where).toHaveBeenCalled();
    });

    it("should use tx when provided", async () => {
      const txUpdateChain = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(undefined),
      };
      const txMock = {
        update: jest.fn(() => txUpdateChain),
      };

      await repository.updateStatus(
        "dunning-123",
        { status: "failed", failureReason: "Card declined" },
        txMock as never,
      );

      expect(txMock.update).toHaveBeenCalled();
      expect(txUpdateChain.set).toHaveBeenCalledWith({
        status: "failed",
        failureReason: "Card declined",
      });
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("markRemainingAsSkipped", () => {
    it("should update all scheduled attempts for invoice to skipped", async () => {
      await repository.markRemainingAsSkipped("inv-123");

      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith({ status: "skipped" });
      expect(updateChain.where).toHaveBeenCalled();
    });

    it("should use tx when provided", async () => {
      const txUpdateChain = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(undefined),
      };
      const txMock = {
        update: jest.fn(() => txUpdateChain),
      };

      await repository.markRemainingAsSkipped("inv-123", txMock as never);

      expect(txMock.update).toHaveBeenCalled();
      expect(txUpdateChain.set).toHaveBeenCalledWith({ status: "skipped" });
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("findWithInvoiceAndPaymentMethod", () => {
    const mockJoinResult = {
      id: "dunning-123",
      invoiceId: "inv-123",
      chargeId: null,
      paymentMethodId: "pm-123",
      attemptNumber: 1,
      scheduledDate: now,
      executedAt: null,
      status: "scheduled",
      failureReason: null,
      createdAt: now,
      paymentMethodType: "card",
      gatewayProvider: "stripe",
    };

    it("should return dunning attempts with invoice and payment method details", async () => {
      selectChain.limit.mockResolvedValueOnce([mockJoinResult]);

      const result = await repository.findWithInvoiceAndPaymentMethod(
        "cust-123",
        {},
        20,
      );

      expect(result).toEqual([mockJoinResult]);
      expect(selectChain.innerJoin).toHaveBeenCalled();
      expect(selectChain.leftJoin).toHaveBeenCalled();
      expect(selectChain.orderBy).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should apply date and cursor filters", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.findWithInvoiceAndPaymentMethod(
        "cust-123",
        {
          dateFrom: "2026-01-01",
          dateTo: "2026-02-01",
          cursor: "dunning-prev",
        },
        20,
      );

      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should return empty array when no results", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findWithInvoiceAndPaymentMethod(
        "cust-123",
        {},
        20,
      );

      expect(result).toEqual([]);
    });
  });

  describe("aggregateDunningByDateRange", () => {
    it("should return aggregated dunning metrics from raw SQL", async () => {
      executeMock.mockResolvedValueOnce({
        rows: [
          {
            totalInvoicesInDunning: 5,
            recoveredCount: 3,
            recoveredAmountCents: 30000,
            avgRecoveryAttempts: "1.67",
          },
        ],
      });

      const result = await repository.aggregateDunningByDateRange(
        "2026-01-01",
        "2026-02-01",
      );

      expect(result).toEqual({
        totalInvoicesInDunning: 5,
        recoveredCount: 3,
        recoveredAmountCents: 30000,
        avgRecoveryAttempts: 1.67,
      });
      expect(executeMock).toHaveBeenCalledTimes(1);
    });

    it("should return zeros when no rows are returned", async () => {
      executeMock.mockResolvedValueOnce({ rows: [] });

      const result = await repository.aggregateDunningByDateRange(
        "2026-01-01",
        "2026-02-01",
      );

      expect(result).toEqual({
        totalInvoicesInDunning: 0,
        recoveredCount: 0,
        recoveredAmountCents: 0,
        avgRecoveryAttempts: 0,
      });
    });

    it("should convert avgRecoveryAttempts string to number", async () => {
      executeMock.mockResolvedValueOnce({
        rows: [
          {
            totalInvoicesInDunning: 2,
            recoveredCount: 1,
            recoveredAmountCents: 10000,
            avgRecoveryAttempts: "2.5",
          },
        ],
      });

      const result = await repository.aggregateDunningByDateRange(
        "2026-01-01",
        "2026-02-01",
      );

      expect(result.avgRecoveryAttempts).toBe(2.5);
      expect(typeof result.avgRecoveryAttempts).toBe("number");
    });
  });

  describe("aggregateEscalatedByDateRange", () => {
    it("should return escalated count and amount from raw SQL", async () => {
      executeMock.mockResolvedValueOnce({
        rows: [{ escalatedCount: 2, escalatedAmountCents: 20000 }],
      });

      const result = await repository.aggregateEscalatedByDateRange(
        "2026-01-01",
        "2026-02-01",
      );

      expect(result).toEqual({
        escalatedCount: 2,
        escalatedAmountCents: 20000,
      });
      expect(executeMock).toHaveBeenCalledTimes(1);
    });

    it("should return zeros when no rows are returned", async () => {
      executeMock.mockResolvedValueOnce({ rows: [] });

      const result = await repository.aggregateEscalatedByDateRange(
        "2026-01-01",
        "2026-02-01",
      );

      expect(result).toEqual({ escalatedCount: 0, escalatedAmountCents: 0 });
    });
  });

  describe("aggregateRecoveryByAttempt", () => {
    it("should return recovery breakdown by attempt number", async () => {
      executeMock.mockResolvedValueOnce({
        rows: [
          { attemptNumber: 1, count: 5 },
          { attemptNumber: 2, count: 2 },
          { attemptNumber: 3, count: 1 },
        ],
      });

      const result = await repository.aggregateRecoveryByAttempt(
        "2026-01-01",
        "2026-02-01",
      );

      expect(result).toEqual([
        { attemptNumber: 1, count: 5 },
        { attemptNumber: 2, count: 2 },
        { attemptNumber: 3, count: 1 },
      ]);
      expect(result).toHaveLength(3);
      expect(executeMock).toHaveBeenCalledTimes(1);
    });

    it("should return empty array when no recoveries exist", async () => {
      executeMock.mockResolvedValueOnce({ rows: [] });

      const result = await repository.aggregateRecoveryByAttempt(
        "2026-01-01",
        "2026-02-01",
      );

      expect(result).toEqual([]);
    });
  });

  describe("aggregateDunningStats", () => {
    it("should return total dunning and recovered counts from raw SQL", async () => {
      executeMock.mockResolvedValueOnce({
        rows: [{ totalDunning: 10, recovered: 8 }],
      });

      const result = await repository.aggregateDunningStats(
        "2026-01-01",
        "2026-02-01",
      );

      expect(result).toEqual({ totalDunning: 10, recovered: 8 });
      expect(executeMock).toHaveBeenCalledTimes(1);
    });

    it("should return zeros when no rows are returned", async () => {
      executeMock.mockResolvedValueOnce({ rows: [] });

      const result = await repository.aggregateDunningStats(
        "2026-01-01",
        "2026-02-01",
      );

      expect(result).toEqual({ totalDunning: 0, recovered: 0 });
    });
  });
});
