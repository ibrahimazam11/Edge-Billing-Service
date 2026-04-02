import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { SurchargeConfigService } from "./surcharge-config.service";
import { SurchargeConfigRepository } from "./surcharge-config.repository";

describe("SurchargeConfigService", () => {
  let service: SurchargeConfigService;
  let logSpy: jest.SpyInstance;
  let mockSurchargeConfigRepo: {
    findByCustomer: jest.Mock;
    upsert: jest.Mock;
    deleteByCustomer: jest.Mock;
  };

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
    mockSurchargeConfigRepo = {
      findByCustomer: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(sampleConfig),
      deleteByCustomer: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SurchargeConfigService,
        {
          provide: SurchargeConfigRepository,
          useValue: mockSurchargeConfigRepo,
        },
      ],
    }).compile();

    service = module.get<SurchargeConfigService>(SurchargeConfigService);
    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe("getConfig", () => {
    it("should return config when it exists", async () => {
      mockSurchargeConfigRepo.findByCustomer.mockResolvedValue(sampleConfig);

      const result = await service.getConfig("cust-1");

      expect(result).not.toBeNull();
      expect(result!.customerId).toBe("cust-1");
      expect(result!.allowCreditCard).toBe(true);
      expect(result!.surchargeType).toBe("percentage");
      expect(result!.surchargeValue).toBe(350);
      expect(result!.reason).toBe("Credit card convenience fee");
      expect(result!.notes).toBe("Applied per contract");
      expect(result!.enabledBy).toBe("admin-user-1");
    });

    it("should return null when no config exists", async () => {
      mockSurchargeConfigRepo.findByCustomer.mockResolvedValue(null);

      const result = await service.getConfig("cust-99");

      expect(result).toBeNull();
    });
  });

  describe("upsertConfig", () => {
    it("should create new config with all fields", async () => {
      const dto = {
        allowCreditCard: true,
        surchargeType: "percentage" as const,
        surchargeValue: 350,
        reason: "Credit card convenience fee",
        notes: "Applied per contract",
        enabledBy: "admin-user-1",
      };

      const result = await service.upsertConfig("cust-1", dto);

      expect(mockSurchargeConfigRepo.upsert).toHaveBeenCalledWith("cust-1", {
        allowCreditCard: true,
        surchargeType: "percentage",
        surchargeValue: 350,
        reason: "Credit card convenience fee",
        notes: "Applied per contract",
        enabledBy: "admin-user-1",
      });
      expect(result.customerId).toBe("cust-1");
    });

    it("should handle null optional fields", async () => {
      const dto = {
        allowCreditCard: false,
      };

      mockSurchargeConfigRepo.upsert.mockResolvedValueOnce({
        ...sampleConfig,
        allowCreditCard: false,
        surchargeType: null,
        surchargeValue: null,
        reason: null,
        notes: null,
        enabledBy: null,
      });

      const result = await service.upsertConfig("cust-1", dto);

      expect(mockSurchargeConfigRepo.upsert).toHaveBeenCalledWith("cust-1", {
        allowCreditCard: false,
        surchargeType: undefined,
        surchargeValue: undefined,
        reason: undefined,
        notes: undefined,
        enabledBy: undefined,
      });
      expect(result.surchargeType).toBeNull();
    });

    it("should log upsert action", async () => {
      await service.upsertConfig("cust-1", { allowCreditCard: true });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cust-1",
          action: "surcharge_config.upserted",
        }),
      );
    });
  });

  describe("deleteConfig", () => {
    it("should delete config by customerId", async () => {
      await service.deleteConfig("cust-1");

      expect(mockSurchargeConfigRepo.deleteByCustomer).toHaveBeenCalledWith(
        "cust-1",
      );
    });

    it("should log delete action", async () => {
      await service.deleteConfig("cust-1");

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cust-1",
          action: "surcharge_config.deleted",
        }),
      );
    });
  });
});
