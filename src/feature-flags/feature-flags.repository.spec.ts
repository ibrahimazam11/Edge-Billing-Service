import { Test } from "@nestjs/testing";
import { FeatureFlagsRepository } from "./feature-flags.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

describe("FeatureFlagsRepository", () => {
  let repository: FeatureFlagsRepository;
  let mockDb: Record<string, jest.Mock>;

  const now = new Date("2026-02-11T00:00:00Z");
  const mockFlag = {
    id: "flag-001",
    customerId: "cust-1",
    flagName: "billing_service_enabled",
    enabled: true,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  };

  beforeEach(async () => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      orderBy: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      onConflictDoUpdate: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        FeatureFlagsRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<FeatureFlagsRepository>(FeatureFlagsRepository);
  });

  describe("findByKey", () => {
    it("should return flag when found", async () => {
      mockDb.limit.mockResolvedValueOnce([{ enabled: true }]);

      const result = await repository.findByKey(
        "cust-1",
        "billing_service_enabled",
      );

      expect(result).toEqual({ enabled: true });
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("should return null when not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repository.findByKey("cust-1", "nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("findByCustomer", () => {
    it("should return all flags for a customer", async () => {
      mockDb.where.mockResolvedValueOnce([mockFlag]);

      const result = await repository.findByCustomer("cust-1");

      expect(result).toEqual([mockFlag]);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
    });

    it("should return empty array when no flags exist", async () => {
      mockDb.where.mockResolvedValueOnce([]);

      const result = await repository.findByCustomer("cust-99");

      expect(result).toEqual([]);
    });
  });

  describe("upsert", () => {
    it("should insert with on-conflict update", async () => {
      mockDb.onConflictDoUpdate.mockResolvedValueOnce(undefined);

      await repository.upsert("cust-1", "billing_service_enabled", true);

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cust-1",
          flagName: "billing_service_enabled",
          enabled: true,
        }),
      );
      expect(mockDb.onConflictDoUpdate).toHaveBeenCalled();
    });

    it("should pass metadata when provided", async () => {
      mockDb.onConflictDoUpdate.mockResolvedValueOnce(undefined);

      const metadata = { source: "migration" };
      await repository.upsert(
        "cust-1",
        "billing_service_enabled",
        true,
        metadata,
      );

      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({ metadata }),
      );
    });

    it("should not include metadata in conflict set when not provided", async () => {
      mockDb.onConflictDoUpdate.mockResolvedValueOnce(undefined);

      await repository.upsert("cust-1", "billing_service_enabled", true);

      const conflictArg = mockDb.onConflictDoUpdate.mock.calls[0][0] as {
        set: Record<string, unknown>;
      };
      expect(conflictArg.set).not.toHaveProperty("metadata");
    });

    it("should include metadata in conflict set when provided", async () => {
      mockDb.onConflictDoUpdate.mockResolvedValueOnce(undefined);

      const metadata = { source: "migration" };
      await repository.upsert(
        "cust-1",
        "billing_service_enabled",
        true,
        metadata,
      );

      const conflictArg = mockDb.onConflictDoUpdate.mock.calls[0][0] as {
        set: Record<string, unknown>;
      };
      expect(conflictArg.set).toHaveProperty("metadata", metadata);
    });
  });

  describe("disable", () => {
    it("should update flag to disabled and return id", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "flag-001" }]);

      const result = await repository.disable(
        "cust-1",
        "billing_service_enabled",
      );

      expect(result).toEqual({ id: "flag-001" });
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );
    });

    it("should return undefined when no flag was updated", async () => {
      mockDb.returning.mockResolvedValueOnce([]);

      const result = await repository.disable("cust-1", "nonexistent");

      expect(result).toBeUndefined();
    });
  });

  describe("bulkEnableInTx", () => {
    it("should enable flags for all customers in transaction", async () => {
      const txMock = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      };

      await repository.bulkEnableInTx(
        ["cust-1", "cust-2", "cust-3"],
        "billing_service_enabled",
        txMock as never,
      );

      expect(txMock.insert).toHaveBeenCalledTimes(3);
    });

    it("should not use main db connection", async () => {
      const txMock = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      };

      await repository.bulkEnableInTx(
        ["cust-1"],
        "billing_service_enabled",
        txMock as never,
      );

      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("bulkDisableInTx", () => {
    it("should disable flags for all customers in transaction", async () => {
      const txMock = {
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      };

      await repository.bulkDisableInTx(
        ["cust-1", "cust-2"],
        "dual_write_enabled",
        txMock as never,
      );

      expect(txMock.update).toHaveBeenCalledTimes(2);
    });

    it("should not use main db connection", async () => {
      const txMock = {
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      };

      await repository.bulkDisableInTx(
        ["cust-1"],
        "dual_write_enabled",
        txMock as never,
      );

      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("countEnabledByFlagName", () => {
    it("should return count of enabled flags for a given flag name", async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ count: 15 }],
      });

      const result =
        await repository.countEnabledByFlagName("dual_write_enabled");

      expect(result).toBe(15);
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("should return 0 when no rows returned", async () => {
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

      const result =
        await repository.countEnabledByFlagName("nonexistent_flag");

      expect(result).toBe(0);
    });

    it("should return 0 when count is 0", async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ count: 0 }],
      });

      const result =
        await repository.countEnabledByFlagName("dual_write_enabled");

      expect(result).toBe(0);
    });
  });
});
