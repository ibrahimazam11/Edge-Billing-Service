import { Test } from "@nestjs/testing";
import { ReconciliationRunsRepository } from "./reconciliation-runs.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

describe("ReconciliationRunsRepository", () => {
  let repository: ReconciliationRunsRepository;
  let mockDb: Record<string, jest.Mock>;

  const mockRun = {
    id: "run-001",
    periodStart: new Date("2026-02-09T00:00:00Z"),
    periodEnd: new Date("2026-02-10T00:00:00Z"),
    status: "balanced" as const,
    recordsCompared: 10,
    totalInternalAmountCents: 50000,
    totalStripeAmountCents: 50000,
    errorReason: null,
    correlationId: "corr-1",
    createdAt: new Date("2026-02-10T01:00:00Z"),
  };

  const executeMock = jest.fn();

  beforeEach(async () => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      orderBy: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([mockRun]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      execute: executeMock,
    };

    const module = await Test.createTestingModule({
      providers: [
        ReconciliationRunsRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<ReconciliationRunsRepository>(
      ReconciliationRunsRepository,
    );
  });

  describe("findExistingRun", () => {
    it("should return existing run when found", async () => {
      mockDb.limit.mockResolvedValueOnce([mockRun]);

      const result = await repository.findExistingRun(
        new Date("2026-02-09T00:00:00Z"),
        new Date("2026-02-10T00:00:00Z"),
      );

      expect(result).toEqual(mockRun);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(1);
    });

    it("should return undefined when no existing run", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repository.findExistingRun(
        new Date("2026-02-09T00:00:00Z"),
        new Date("2026-02-10T00:00:00Z"),
      );

      expect(result).toBeUndefined();
    });
  });

  describe("createInTx", () => {
    it("should insert run using provided transaction", async () => {
      const txMock = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        }),
      };

      await repository.createInTx(mockRun as never, txMock as never);

      expect(txMock.insert).toHaveBeenCalled();
    });

    it("should not use the main db connection", async () => {
      const txMock = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        }),
      };

      await repository.createInTx(mockRun as never, txMock as never);

      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("createFailed", () => {
    it("should insert failed run using main db connection", async () => {
      mockDb.values.mockResolvedValueOnce(undefined);

      await repository.createFailed(mockRun as never);

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalled();
    });
  });

  describe("inherited findById", () => {
    it("should find run by id", async () => {
      mockDb.limit.mockResolvedValueOnce([mockRun]);

      const result = await repository.findById("run-001");

      expect(result).toEqual(mockRun);
    });

    it("should return null when not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repository.findById("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("findByDateRange", () => {
    it("should return runs matching filters", async () => {
      mockDb.limit.mockResolvedValueOnce([mockRun]);

      const result = await repository.findByDateRange(
        { status: "balanced", startDate: "2026-01-01", endDate: "2026-02-01" },
        20,
      );

      expect(result).toEqual([mockRun]);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
      expect(mockDb.orderBy).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(21);
    });

    it("should apply cursor filter", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repository.findByDateRange(
        { cursor: "run-prev" },
        20,
      );

      expect(result).toEqual([]);
      expect(mockDb.where).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(21);
    });

    it("should return empty array when no runs match", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repository.findByDateRange({}, 20);

      expect(result).toEqual([]);
    });

    it("should work with no filters", async () => {
      mockDb.limit.mockResolvedValueOnce([mockRun]);

      const result = await repository.findByDateRange({}, 10);

      expect(result).toEqual([mockRun]);
      expect(mockDb.limit).toHaveBeenCalledWith(11);
    });
  });

  describe("getLatestRunStatus", () => {
    it("should return the status of the latest run", async () => {
      executeMock.mockResolvedValueOnce({
        rows: [{ status: "balanced" }],
      });

      const result = await repository.getLatestRunStatus();

      expect(result).toBe("balanced");
      expect(executeMock).toHaveBeenCalledTimes(1);
    });

    it("should return null when no runs exist", async () => {
      executeMock.mockResolvedValueOnce({ rows: [] });

      const result = await repository.getLatestRunStatus();

      expect(result).toBeNull();
    });

    it("should return discrepancy_found status", async () => {
      executeMock.mockResolvedValueOnce({
        rows: [{ status: "discrepancy_found" }],
      });

      const result = await repository.getLatestRunStatus();

      expect(result).toBe("discrepancy_found");
    });
  });
});
