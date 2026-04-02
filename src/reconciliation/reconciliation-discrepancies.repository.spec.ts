import { Test } from "@nestjs/testing";
import { ReconciliationDiscrepanciesRepository } from "./reconciliation-discrepancies.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

const now = new Date("2026-02-10T00:00:00.000Z");

const mockDiscrepancyRow = {
  id: "disc-123",
  reconciliationRunId: "run-123",
  type: "amount_mismatch",
  internalReferenceId: "charge-1",
  stripeTransactionId: "txn_1",
  expectedAmountCents: 5000,
  actualAmountCents: 4500,
  differenceCents: 500,
  disputeStatus: "open",
  resolvedBy: null,
  resolutionNotes: null,
  resolvedAt: null,
  createdAt: now,
};

const mockDiscrepancyWithRun = {
  ...mockDiscrepancyRow,
  periodStart: new Date("2026-02-09T00:00:00.000Z"),
  periodEnd: new Date("2026-02-10T00:00:00.000Z"),
};

describe("ReconciliationDiscrepanciesRepository", () => {
  let repository: ReconciliationDiscrepanciesRepository;
  let selectChain: Record<string, jest.Mock>;
  let insertChain: Record<string, jest.Mock>;
  let updateChain: Record<string, jest.Mock>;
  let mockDb: Record<string, jest.Mock>;

  beforeEach(async () => {
    selectChain = {
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      then: jest.fn((resolve: (value: unknown[]) => void) => resolve([])),
    };

    insertChain = {
      values: jest.fn().mockResolvedValue(undefined),
    };

    updateChain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([]),
    };

    mockDb = {
      select: jest.fn(() => selectChain),
      insert: jest.fn(() => insertChain),
      update: jest.fn(() => updateChain),
    };

    const module = await Test.createTestingModule({
      providers: [
        ReconciliationDiscrepanciesRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<ReconciliationDiscrepanciesRepository>(
      ReconciliationDiscrepanciesRepository,
    );
  });

  describe("findById", () => {
    it("should return discrepancy when found", async () => {
      selectChain.limit.mockResolvedValueOnce([mockDiscrepancyRow]);

      const result = await repository.findById("disc-123");

      expect(result).toEqual(mockDiscrepancyRow);
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

  describe("findWithRunDetails", () => {
    it("should return discrepancy with run details via LEFT JOIN", async () => {
      selectChain.limit.mockResolvedValueOnce([mockDiscrepancyWithRun]);

      const result = await repository.findWithRunDetails("disc-123");

      expect(result).toEqual(mockDiscrepancyWithRun);
      expect(mockDb.select).toHaveBeenCalled();
      expect(selectChain.from).toHaveBeenCalled();
      expect(selectChain.leftJoin).toHaveBeenCalled();
      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });

    it("should return null when not found", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findWithRunDetails("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("search", () => {
    it("should return results with LEFT JOIN and pagination", async () => {
      selectChain.limit.mockResolvedValueOnce([mockDiscrepancyWithRun]);

      const result = await repository.search({}, 20);

      expect(result).toEqual([mockDiscrepancyWithRun]);
      expect(selectChain.leftJoin).toHaveBeenCalled();
      expect(selectChain.orderBy).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should apply disputeStatus filter", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.search({ disputeStatus: "open" }, 20);

      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should apply all filters including cursor", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.search(
        {
          disputeStatus: "open",
          runId: "run-1",
          dateFrom: "2026-01-01",
          dateTo: "2026-02-01",
          cursor: "disc-abc",
        },
        10,
      );

      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(11);
    });

    it("should handle empty conditions (no filters)", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.search({}, 20);

      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.orderBy).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });
  });

  describe("findByRunIds", () => {
    it("should return discrepancies for given run IDs", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([mockDiscrepancyRow]),
      );

      const result = await repository.findByRunIds(["run-123"]);

      expect(result).toEqual([mockDiscrepancyRow]);
      expect(selectChain.where).toHaveBeenCalled();
    });

    it("should return empty array for empty runIds without querying", async () => {
      const result = await repository.findByRunIds([]);

      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe("insertBatch", () => {
    it("should insert discrepancies", async () => {
      const discrepancies = [
        {
          id: "disc-1",
          reconciliationRunId: "run-1",
          type: "amount_mismatch" as const,
          internalReferenceId: "charge-1",
          stripeTransactionId: "txn_1",
          expectedAmountCents: 5000,
          actualAmountCents: 4500,
          differenceCents: 500,
        },
      ];

      await repository.insertBatch(discrepancies);

      expect(mockDb.insert).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(discrepancies);
    });

    it("should short-circuit for empty array without querying", async () => {
      await repository.insertBatch([]);

      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("should use transaction client when provided", async () => {
      const txMock = {
        insert: jest.fn(() => ({
          values: jest.fn().mockResolvedValue(undefined),
        })),
      };

      const discrepancies = [
        {
          id: "disc-1",
          reconciliationRunId: "run-1",
          type: "missing_stripe" as const,
          internalReferenceId: "charge-1",
          stripeTransactionId: null,
          expectedAmountCents: 5000,
          actualAmountCents: 0,
          differenceCents: 5000,
        },
      ];

      await repository.insertBatch(discrepancies, txMock as never);

      expect(txMock.insert).toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("updateDisputeStatus", () => {
    it("should return id when discrepancy is updated", async () => {
      updateChain.returning.mockResolvedValueOnce([{ id: "disc-123" }]);

      const result = await repository.updateDisputeStatus(
        "disc-123",
        "investigating",
      );

      expect(result).toEqual({ id: "disc-123" });
      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith({
        disputeStatus: "investigating",
      });
      expect(updateChain.where).toHaveBeenCalled();
      expect(updateChain.returning).toHaveBeenCalled();
    });

    it("should return null when discrepancy not found", async () => {
      updateChain.returning.mockResolvedValueOnce([]);

      const result = await repository.updateDisputeStatus(
        "non-existent",
        "investigating",
      );

      expect(result).toBeNull();
    });
  });

  describe("resolve", () => {
    it("should return id when discrepancy is resolved", async () => {
      updateChain.returning.mockResolvedValueOnce([{ id: "disc-123" }]);

      const result = await repository.resolve("disc-123", {
        resolvedBy: "admin-1",
        resolutionNotes: "Manually verified",
      });

      expect(result).toEqual({ id: "disc-123" });
      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          disputeStatus: "resolved",
          resolvedBy: "admin-1",
          resolutionNotes: "Manually verified",
          resolvedAt: expect.any(Date) as Date,
        }),
      );
      expect(updateChain.where).toHaveBeenCalled();
      expect(updateChain.returning).toHaveBeenCalled();
    });

    it("should return null when discrepancy not found", async () => {
      updateChain.returning.mockResolvedValueOnce([]);

      const result = await repository.resolve("non-existent", {
        resolvedBy: "admin-1",
        resolutionNotes: "Manually verified",
      });

      expect(result).toBeNull();
    });
  });

  describe("exportByDateRange", () => {
    it("should return discrepancies with run details for date range", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) =>
          resolve([mockDiscrepancyWithRun]),
      );

      const result = await repository.exportByDateRange(
        "2026-02-01",
        "2026-02-10",
      );

      expect(result).toEqual([mockDiscrepancyWithRun]);
      expect(selectChain.leftJoin).toHaveBeenCalled();
      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.orderBy).toHaveBeenCalled();
    });
  });
});
