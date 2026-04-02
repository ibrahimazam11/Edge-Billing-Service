import { Test } from "@nestjs/testing";
import { CreditBalancesRepository } from "./credit-balances.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

describe("CreditBalancesRepository", () => {
  let repository: CreditBalancesRepository;
  let mockDb: Record<string, jest.Mock>;

  const mockBalance = {
    id: "bal-001",
    customerId: "cust-001",
    balanceCents: 5000,
    currency: "usd",
    updatedAt: new Date("2026-01-15T00:00:00Z"),
  };

  beforeEach(async () => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([mockBalance]),
      onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
    };

    const module = await Test.createTestingModule({
      providers: [
        CreditBalancesRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<CreditBalancesRepository>(CreditBalancesRepository);
  });

  describe("findByCustomer", () => {
    it("should return balance when it exists", async () => {
      mockDb.limit.mockResolvedValueOnce([mockBalance]);

      const result = await repository.findByCustomer("cust-001");

      expect(result).toEqual(mockBalance);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
    });

    it("should return null when no balance exists", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repository.findByCustomer("cust-999");

      expect(result).toBeNull();
    });
  });

  describe("findByCustomerInTx", () => {
    it("should use transaction to find balance", async () => {
      const txMock = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([mockBalance]),
            }),
          }),
        }),
      };

      const result = await repository.findByCustomerInTx(
        "cust-001",
        txMock as never,
      );

      expect(result).toEqual(mockBalance);
      expect(txMock.select).toHaveBeenCalled();
    });

    it("should return null when no balance found in tx", async () => {
      const txMock = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      };

      const result = await repository.findByCustomerInTx(
        "cust-999",
        txMock as never,
      );

      expect(result).toBeNull();
    });
  });

  describe("upsertInTx", () => {
    it("should insert with on-conflict update using transaction", async () => {
      const txMock = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      };

      await repository.upsertInTx(mockBalance as never, 2000, txMock as never);

      expect(txMock.insert).toHaveBeenCalled();
    });

    it("should not use main db connection", async () => {
      const txMock = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      };

      await repository.upsertInTx(mockBalance as never, 2000, txMock as never);

      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("deductInTx", () => {
    it("should deduct balance using transaction", async () => {
      const txMock = {
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      };

      await repository.deductInTx("cust-001", 3000, txMock as never);

      expect(txMock.update).toHaveBeenCalled();
    });

    it("should not use main db connection", async () => {
      const txMock = {
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      };

      await repository.deductInTx("cust-001", 3000, txMock as never);

      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });
});
