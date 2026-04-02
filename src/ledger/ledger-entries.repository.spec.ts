import { Test } from "@nestjs/testing";
import { LedgerEntriesRepository } from "./ledger-entries.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

describe("LedgerEntriesRepository", () => {
  let repository: LedgerEntriesRepository;
  let mockDb: Record<string, jest.Mock>;

  const mockEntry = {
    id: "e0000000-0000-4000-a000-000000000001",
    debitAccountId: "a0000000-0000-4000-a000-000000000001",
    creditAccountId: "a0000000-0000-4000-a000-000000000002",
    amountCents: 5000,
    currency: "usd",
    referenceType: "invoice",
    referenceId: "inv-001",
    description: "Invoice finalized",
    correlationId: "corr-001",
    createdAt: new Date("2026-01-15T00:00:00Z"),
  };

  beforeEach(async () => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
      limit: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([mockEntry]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({
        rows: [
          {
            totalInvoiced: "50000",
            totalCollected: "45000",
            totalWriteOff: "2000",
            totalCreditsIssued: "3000",
          },
        ],
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        LedgerEntriesRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<LedgerEntriesRepository>(LedgerEntriesRepository);
  });

  describe("createInTx", () => {
    it("should insert ledger entry using provided transaction", async () => {
      const txMock = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        }),
      };

      await repository.createInTx(mockEntry as never, txMock as never);

      expect(txMock.insert).toHaveBeenCalled();
    });

    it("should not use the main db connection", async () => {
      const txMock = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        }),
      };

      await repository.createInTx(mockEntry as never, txMock as never);

      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("findByReferenceType", () => {
    it("should return entries matching reference type and date range", async () => {
      const expectedEntries = [{ referenceId: "charge-1" }];
      mockDb.where.mockResolvedValueOnce(expectedEntries);

      const result = await repository.findByReferenceType("payment", {
        start: new Date("2026-02-09T00:00:00Z"),
        end: new Date("2026-02-10T00:00:00Z"),
      });

      expect(result).toEqual(expectedEntries);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
    });

    it("should return empty array when no entries found", async () => {
      mockDb.where.mockResolvedValueOnce([]);

      const result = await repository.findByReferenceType("payment", {
        start: new Date("2026-02-09T00:00:00Z"),
        end: new Date("2026-02-10T00:00:00Z"),
      });

      expect(result).toEqual([]);
    });
  });

  describe("aggregateRevenueByDateRange", () => {
    it("should return aggregated revenue figures", async () => {
      const result = await repository.aggregateRevenueByDateRange(
        new Date("2026-02-01T00:00:00Z"),
        new Date("2026-03-01T00:00:00Z"),
      );

      expect(result).toEqual({
        totalInvoiced: 50000,
        totalCollected: 45000,
        totalWriteOff: 2000,
        totalCreditsIssued: 3000,
      });
      expect(mockDb.execute).toHaveBeenCalled();
    });

    it("should return zeros when no entries exist", async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [
          {
            totalInvoiced: "0",
            totalCollected: "0",
            totalWriteOff: "0",
            totalCreditsIssued: "0",
          },
        ],
      });

      const result = await repository.aggregateRevenueByDateRange(
        new Date("2026-02-01T00:00:00Z"),
        new Date("2026-03-01T00:00:00Z"),
      );

      expect(result).toEqual({
        totalInvoiced: 0,
        totalCollected: 0,
        totalWriteOff: 0,
        totalCreditsIssued: 0,
      });
    });
  });
});
