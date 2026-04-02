import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { FeatureFlagService } from "./feature-flags.service";
import { FeatureFlagsRepository } from "./feature-flags.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

describe("FeatureFlagService", () => {
  let service: FeatureFlagService;
  let logSpy: jest.SpyInstance;
  let mockFeatureFlagsRepo: {
    findByKey: jest.Mock;
    findByCustomer: jest.Mock;
    upsert: jest.Mock;
    disable: jest.Mock;
    bulkEnableInTx: jest.Mock;
    bulkDisableInTx: jest.Mock;
  };

  const txMock = {};

  const mockDb = {
    transaction: jest.fn((cb: (tx: typeof txMock) => Promise<void>) =>
      cb(txMock),
    ),
  };

  beforeEach(async () => {
    mockFeatureFlagsRepo = {
      findByKey: jest.fn().mockResolvedValue(null),
      findByCustomer: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(undefined),
      disable: jest.fn().mockResolvedValue({ id: "flag-1" }),
      bulkEnableInTx: jest.fn().mockResolvedValue(undefined),
      bulkDisableInTx: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeatureFlagService,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
        { provide: FeatureFlagsRepository, useValue: mockFeatureFlagsRepo },
      ],
    }).compile();

    service = module.get<FeatureFlagService>(FeatureFlagService);
    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe("isEnabled", () => {
    it("should return true when flag exists and is enabled", async () => {
      mockFeatureFlagsRepo.findByKey.mockResolvedValue({ enabled: true });

      const result = await service.isEnabled(
        "cust-1",
        "billing_service_enabled",
      );

      expect(result).toBe(true);
      expect(mockFeatureFlagsRepo.findByKey).toHaveBeenCalledWith(
        "cust-1",
        "billing_service_enabled",
      );
    });

    it("should return false when flag exists but is disabled", async () => {
      mockFeatureFlagsRepo.findByKey.mockResolvedValue({ enabled: false });

      const result = await service.isEnabled(
        "cust-1",
        "billing_service_enabled",
      );

      expect(result).toBe(false);
    });

    it("should return false when no record exists", async () => {
      mockFeatureFlagsRepo.findByKey.mockResolvedValue(null);

      const result = await service.isEnabled(
        "cust-1",
        "billing_service_enabled",
      );

      expect(result).toBe(false);
    });
  });

  describe("enableFlag", () => {
    it("should upsert flag to enabled via repository", async () => {
      await service.enableFlag("cust-1", "billing_service_enabled");

      expect(mockFeatureFlagsRepo.upsert).toHaveBeenCalledWith(
        "cust-1",
        "billing_service_enabled",
        true,
        undefined,
      );
    });

    it("should pass metadata when provided", async () => {
      const metadata = { source: "migration" };
      await service.enableFlag("cust-1", "billing_service_enabled", metadata);

      expect(mockFeatureFlagsRepo.upsert).toHaveBeenCalledWith(
        "cust-1",
        "billing_service_enabled",
        true,
        metadata,
      );
    });

    it("should log flag change", async () => {
      await service.enableFlag(
        "cust-1",
        "billing_service_enabled",
        undefined,
        "corr-1",
      );

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cust-1",
          flagName: "billing_service_enabled",
          enabled: true,
          action: "flag.changed",
          correlationId: "corr-1",
        }),
      );
    });

    it("should not include metadata in conflict update when not provided", async () => {
      await service.enableFlag("cust-1", "billing_service_enabled");

      // Verify upsert was called with undefined metadata
      expect(mockFeatureFlagsRepo.upsert).toHaveBeenCalledWith(
        "cust-1",
        "billing_service_enabled",
        true,
        undefined,
      );
    });

    it("should include metadata in conflict update when provided", async () => {
      const metadata = { source: "migration" };
      await service.enableFlag("cust-1", "billing_service_enabled", metadata);

      expect(mockFeatureFlagsRepo.upsert).toHaveBeenCalledWith(
        "cust-1",
        "billing_service_enabled",
        true,
        metadata,
      );
    });
  });

  describe("disableFlag", () => {
    it("should disable flag via repository", async () => {
      await service.disableFlag("cust-1", "billing_service_enabled");

      expect(mockFeatureFlagsRepo.disable).toHaveBeenCalledWith(
        "cust-1",
        "billing_service_enabled",
      );
    });

    it("should log flag change", async () => {
      await service.disableFlag("cust-1", "dual_write_enabled", "corr-2");

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cust-1",
          flagName: "dual_write_enabled",
          enabled: false,
          action: "flag.changed",
          correlationId: "corr-2",
        }),
      );
    });

    it("should not log when no flag was updated (non-existent flag)", async () => {
      mockFeatureFlagsRepo.disable.mockResolvedValue(undefined);

      await service.disableFlag("cust-1", "nonexistent_flag");

      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe("enableFlagBulk", () => {
    it("should use db.transaction for bulk enable", async () => {
      const customerIds = ["cust-1", "cust-2", "cust-3"];
      await service.enableFlagBulk(customerIds, "billing_service_enabled");

      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockFeatureFlagsRepo.bulkEnableInTx).toHaveBeenCalledWith(
        customerIds,
        "billing_service_enabled",
        txMock,
      );
    });

    it("should log bulk enable with customerCount", async () => {
      const customerIds = ["cust-1", "cust-2"];
      await service.enableFlagBulk(
        customerIds,
        "billing_service_enabled",
        "corr-bulk",
      );

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          flagName: "billing_service_enabled",
          customerCount: 2,
          action: "flag.bulk_enabled",
          correlationId: "corr-bulk",
        }),
      );
    });
  });

  describe("disableFlagBulk", () => {
    it("should use db.transaction for bulk disable", async () => {
      const customerIds = ["cust-1", "cust-2"];
      await service.disableFlagBulk(customerIds, "dual_write_enabled");

      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockFeatureFlagsRepo.bulkDisableInTx).toHaveBeenCalledWith(
        customerIds,
        "dual_write_enabled",
        txMock,
      );
    });

    it("should log bulk disable with customerCount", async () => {
      const customerIds = ["cust-1"];
      await service.disableFlagBulk(
        customerIds,
        "dual_write_enabled",
        "corr-bulk-d",
      );

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          flagName: "dual_write_enabled",
          customerCount: 1,
          action: "flag.bulk_disabled",
          correlationId: "corr-bulk-d",
        }),
      );
    });
  });

  describe("getFlags", () => {
    it("should return all flags for a customer", async () => {
      const now = new Date();
      mockFeatureFlagsRepo.findByCustomer.mockResolvedValue([
        {
          id: "flag-1",
          customerId: "cust-1",
          flagName: "billing_service_enabled",
          enabled: true,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "flag-2",
          customerId: "cust-1",
          flagName: "dual_write_enabled",
          enabled: false,
          metadata: { version: 2 },
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const result = await service.getFlags("cust-1");

      expect(result).toHaveLength(2);
      expect(result[0].flagName).toBe("billing_service_enabled");
      expect(result[0].enabled).toBe(true);
      expect(result[1].flagName).toBe("dual_write_enabled");
      expect(result[1].enabled).toBe(false);
    });

    it("should return empty array when no flags exist", async () => {
      mockFeatureFlagsRepo.findByCustomer.mockResolvedValue([]);

      const result = await service.getFlags("cust-99");

      expect(result).toHaveLength(0);
    });
  });
});
