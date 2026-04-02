import { Test } from "@nestjs/testing";
import { LedgerAccountsRepository } from "./ledger-accounts.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

describe("LedgerAccountsRepository", () => {
  let repository: LedgerAccountsRepository;
  let mockDb: Record<string, jest.Mock>;

  const mockAccounts = [
    {
      id: "a0000000-0000-4000-a000-000000000001",
      name: "accounts_receivable",
      type: "accounts_receivable",
      description: "AR account",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      id: "a0000000-0000-4000-a000-000000000002",
      name: "revenue",
      type: "revenue",
      description: "Revenue account",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  ];

  beforeEach(async () => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      orderBy: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
    };

    const module = await Test.createTestingModule({
      providers: [
        LedgerAccountsRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<LedgerAccountsRepository>(LedgerAccountsRepository);
  });

  describe("findAll", () => {
    it("should return all ledger accounts", async () => {
      // findAll calls select().from() — for this case from() is the terminal call
      mockDb.from.mockResolvedValueOnce(mockAccounts);

      const result = await repository.findAll();

      expect(result).toEqual(mockAccounts);
      expect(result).toHaveLength(2);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
    });

    it("should return empty array when no accounts exist", async () => {
      mockDb.from.mockResolvedValueOnce([]);

      const result = await repository.findAll();

      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });
  });

  describe("inherited findById", () => {
    it("should find ledger account by id", async () => {
      mockDb.limit.mockResolvedValueOnce([mockAccounts[0]]);

      const result = await repository.findById(mockAccounts[0].id);

      expect(result).toEqual(mockAccounts[0]);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("should return null when not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repository.findById("non-existent-id");

      expect(result).toBeNull();
    });
  });
});
