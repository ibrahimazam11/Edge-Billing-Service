import { Test } from "@nestjs/testing";
import { SurchargeConfigRepository } from "./surcharge-config.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

describe("SurchargeConfigRepository", () => {
  let repository: SurchargeConfigRepository;
  let mockDb: Record<string, jest.Mock>;

  const now = new Date("2026-02-11T00:00:00Z");
  const sampleConfig = {
    id: "sc-1",
    customerId: "cust-1",
    allowCreditCard: true,
    surchargeType: "percentage" as const,
    surchargeValue: 350,
    reason: "Credit card convenience fee",
    notes: "Applied per contract",
    enabledBy: "admin-user-1",
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
      returning: jest.fn().mockResolvedValue([sampleConfig]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
    };

    const module = await Test.createTestingModule({
      providers: [
        SurchargeConfigRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<SurchargeConfigRepository>(
      SurchargeConfigRepository,
    );
  });

  describe("findByCustomer", () => {
    it("should return config when it exists", async () => {
      mockDb.limit.mockResolvedValueOnce([sampleConfig]);

      const result = await repository.findByCustomer("cust-1");

      expect(result).toEqual(sampleConfig);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
    });

    it("should return null when no config exists", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repository.findByCustomer("cust-99");

      expect(result).toBeNull();
    });
  });

  describe("upsert", () => {
    it("should create new config with all fields", async () => {
      const result = await repository.upsert("cust-1", {
        allowCreditCard: true,
        surchargeType: "percentage",
        surchargeValue: 350,
        reason: "Credit card convenience fee",
        notes: "Applied per contract",
        enabledBy: "admin-user-1",
      });

      expect(result).toEqual(sampleConfig);
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cust-1",
          allowCreditCard: true,
          surchargeType: "percentage",
          surchargeValue: 350,
        }),
      );
      expect(mockDb.onConflictDoUpdate).toHaveBeenCalled();
      expect(mockDb.returning).toHaveBeenCalled();
    });

    it("should handle null optional fields", async () => {
      mockDb.returning.mockResolvedValueOnce([
        {
          ...sampleConfig,
          allowCreditCard: false,
          surchargeType: null,
          surchargeValue: null,
          reason: null,
          notes: null,
          enabledBy: null,
        },
      ]);

      const result = await repository.upsert("cust-1", {
        allowCreditCard: false,
      });

      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          surchargeType: null,
          surchargeValue: null,
          reason: null,
          notes: null,
          enabledBy: null,
        }),
      );
      expect(result.surchargeType).toBeNull();
    });
  });

  describe("deleteByCustomer", () => {
    it("should delete config by customerId", async () => {
      mockDb.where.mockResolvedValueOnce(undefined);

      await repository.deleteByCustomer("cust-1");

      expect(mockDb.delete).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
    });
  });

  describe("inherited findById", () => {
    it("should find config by id", async () => {
      mockDb.limit.mockResolvedValueOnce([sampleConfig]);

      const result = await repository.findById("sc-1");

      expect(result).toEqual(sampleConfig);
    });

    it("should return null when not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repository.findById("non-existent");

      expect(result).toBeNull();
    });
  });
});
