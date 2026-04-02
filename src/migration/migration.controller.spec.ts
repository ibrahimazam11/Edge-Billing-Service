import { Logger } from "@nestjs/common";
import { MigrationController } from "./migration.controller";
import type { CustomersRepository } from "../customers/customers.repository";
import type { FeatureFlagService } from "../feature-flags/feature-flags.service";
import type { FeatureFlagsRepository } from "../feature-flags/feature-flags.repository";
import type { MigrationLogsRepository } from "./migration-logs.repository";

describe("MigrationController", () => {
  let controller: MigrationController;
  let mockCustomersRepository: {
    findById: jest.Mock;
    countMonolithCustomers: jest.Mock;
  };
  let mockMigrationLogsRepository: {
    findLatestByMonolithCustomerId: jest.Mock;
    getAggregateMigrationStats: jest.Mock;
  };
  let mockFeatureFlagsRepository: {
    countEnabledByFlagName: jest.Mock;
  };
  let mockFeatureFlagService: { isEnabled: jest.Mock };

  beforeEach(() => {
    mockCustomersRepository = {
      findById: jest.fn().mockResolvedValue(null),
      countMonolithCustomers: jest.fn().mockResolvedValue(0),
    };

    mockMigrationLogsRepository = {
      findLatestByMonolithCustomerId: jest.fn().mockResolvedValue(null),
      getAggregateMigrationStats: jest
        .fn()
        .mockResolvedValue({ migrated: 0, failed: 0 }),
    };

    mockFeatureFlagsRepository = {
      countEnabledByFlagName: jest.fn().mockResolvedValue(0),
    };

    mockFeatureFlagService = {
      isEnabled: jest.fn().mockResolvedValue(false),
    };

    controller = new MigrationController(
      mockCustomersRepository as unknown as CustomersRepository,
      mockMigrationLogsRepository as unknown as MigrationLogsRepository,
      mockFeatureFlagsRepository as unknown as FeatureFlagsRepository,
      mockFeatureFlagService as unknown as FeatureFlagService,
    );

    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("GET /v1/migration/status (per-customer)", () => {
    it("should return customer migration status when customerId provided", async () => {
      mockCustomersRepository.findById.mockResolvedValue({
        id: "cust-uuid-1",
        monolithCustomerId: "MONO-001",
      });

      mockMigrationLogsRepository.findLatestByMonolithCustomerId.mockResolvedValue(
        {
          scriptName: "payment_settings_migration",
          status: "success",
          errorMessage: null,
          createdAt: new Date("2026-02-10"),
        },
      );

      mockFeatureFlagService.isEnabled
        .mockResolvedValueOnce(true) // billing_service_enabled
        .mockResolvedValueOnce(true); // dual_write_enabled

      const result = await controller.getStatus("cust-uuid-1");

      expect(result.type).toBe("customer");
      if (result.type === "customer") {
        expect(result.data.customerId).toBe("cust-uuid-1");
        expect(result.data.migrationStatus).toBe("migrated");
        expect(result.data.dualWriteEnabled).toBe(true);
        expect(result.data.billingServiceEnabled).toBe(true);
        expect(result.data.lastMigrationScript).toBe(
          "payment_settings_migration",
        );
      }

      expect(mockCustomersRepository.findById).toHaveBeenCalledWith(
        "cust-uuid-1",
      );
      expect(
        mockMigrationLogsRepository.findLatestByMonolithCustomerId,
      ).toHaveBeenCalledWith("MONO-001");
    });

    it("should return pending status when no migration logs exist", async () => {
      mockCustomersRepository.findById.mockResolvedValue({
        id: "cust-uuid-2",
        monolithCustomerId: "MONO-002",
      });

      mockMigrationLogsRepository.findLatestByMonolithCustomerId.mockResolvedValue(
        null,
      );

      const result = await controller.getStatus("cust-uuid-2");

      if (result.type === "customer") {
        expect(result.data.migrationStatus).toBe("pending");
        expect(result.data.lastMigrationScript).toBeNull();
      }
    });

    it("should return failed status when last migration failed", async () => {
      mockCustomersRepository.findById.mockResolvedValue({
        id: "cust-uuid-3",
        monolithCustomerId: "MONO-003",
      });

      mockMigrationLogsRepository.findLatestByMonolithCustomerId.mockResolvedValue(
        {
          scriptName: "charges_migration",
          status: "failed",
          errorMessage: "Connection timeout",
          createdAt: new Date("2026-02-10"),
        },
      );

      const result = await controller.getStatus("cust-uuid-3");

      if (result.type === "customer") {
        expect(result.data.migrationStatus).toBe("failed");
        expect(result.data.errorMessage).toBe("Connection timeout");
      }
    });

    it("should return pending when customer not found", async () => {
      mockCustomersRepository.findById.mockResolvedValue(null);

      const result = await controller.getStatus("cust-unknown");

      if (result.type === "customer") {
        expect(result.data.migrationStatus).toBe("pending");
      }

      expect(
        mockMigrationLogsRepository.findLatestByMonolithCustomerId,
      ).not.toHaveBeenCalled();
    });
  });

  describe("GET /v1/migration/status (aggregate)", () => {
    it("should return aggregate migration status when no customerId", async () => {
      mockCustomersRepository.countMonolithCustomers.mockResolvedValue(100);
      mockMigrationLogsRepository.getAggregateMigrationStats.mockResolvedValue({
        migrated: 50,
        failed: 5,
      });
      mockFeatureFlagsRepository.countEnabledByFlagName.mockResolvedValue(20);

      const result = await controller.getStatus();

      expect(result.type).toBe("aggregate");
      if (result.type === "aggregate") {
        expect(result.data.totalCustomers).toBe(100);
        expect(result.data.migrated).toBe(50);
        expect(result.data.failed).toBe(5);
        expect(result.data.pending).toBe(45);
        expect(result.data.dualWriteActive).toBe(20);
      }

      expect(
        mockCustomersRepository.countMonolithCustomers,
      ).toHaveBeenCalledTimes(1);
      expect(
        mockMigrationLogsRepository.getAggregateMigrationStats,
      ).toHaveBeenCalledTimes(1);
      expect(
        mockFeatureFlagsRepository.countEnabledByFlagName,
      ).toHaveBeenCalledWith("dual_write_enabled");
    });

    it("should handle zero customers", async () => {
      mockCustomersRepository.countMonolithCustomers.mockResolvedValue(0);
      mockMigrationLogsRepository.getAggregateMigrationStats.mockResolvedValue({
        migrated: 0,
        failed: 0,
      });
      mockFeatureFlagsRepository.countEnabledByFlagName.mockResolvedValue(0);

      const result = await controller.getStatus();

      if (result.type === "aggregate") {
        expect(result.data.totalCustomers).toBe(0);
        expect(result.data.migrated).toBe(0);
        expect(result.data.pending).toBe(0);
        expect(result.data.failed).toBe(0);
        expect(result.data.dualWriteActive).toBe(0);
      }
    });
  });
});
