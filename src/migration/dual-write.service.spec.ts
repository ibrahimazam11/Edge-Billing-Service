import { Logger } from "@nestjs/common";
import { DualWriteService } from "./dual-write.service";
import type { FeatureFlagService } from "../feature-flags/feature-flags.service";
import type { MigrationLogsRepository } from "./migration-logs.repository";

describe("DualWriteService", () => {
  let service: DualWriteService;
  let mockFeatureFlagService: { isEnabled: jest.Mock };
  let mockMigrationLogsRepo: { createLog: jest.Mock };

  beforeEach(() => {
    mockFeatureFlagService = {
      isEnabled: jest.fn(),
    };

    mockMigrationLogsRepo = {
      createLog: jest.fn().mockResolvedValue(undefined),
    };

    service = new DualWriteService(
      mockFeatureFlagService as unknown as FeatureFlagService,
      mockMigrationLogsRepo as unknown as MigrationLogsRepository,
    );

    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("shouldDualWrite", () => {
    it("should return true when both billing_service_enabled and dual_write_enabled are true", async () => {
      mockFeatureFlagService.isEnabled.mockResolvedValue(true);

      const result = await service.shouldDualWrite("cust-1");

      expect(result).toBe(true);
      expect(mockFeatureFlagService.isEnabled).toHaveBeenCalledWith(
        "cust-1",
        "billing_service_enabled",
      );
      expect(mockFeatureFlagService.isEnabled).toHaveBeenCalledWith(
        "cust-1",
        "dual_write_enabled",
      );
    });

    it("should return false when billing_service_enabled is false", async () => {
      mockFeatureFlagService.isEnabled.mockImplementation(
        (_customerId: string, flagName: string) =>
          Promise.resolve(flagName === "dual_write_enabled"),
      );

      const result = await service.shouldDualWrite("cust-1");

      expect(result).toBe(false);
    });

    it("should return false when dual_write_enabled is false", async () => {
      mockFeatureFlagService.isEnabled.mockImplementation(
        (_customerId: string, flagName: string) =>
          Promise.resolve(flagName === "billing_service_enabled"),
      );

      const result = await service.shouldDualWrite("cust-1");

      expect(result).toBe(false);
    });

    it("should return false when both flags are false", async () => {
      mockFeatureFlagService.isEnabled.mockResolvedValue(false);

      const result = await service.shouldDualWrite("cust-1");

      expect(result).toBe(false);
    });
  });

  describe("getDualWriteMetadata", () => {
    it("should return { dual_write: true } when dual-write is enabled", async () => {
      mockFeatureFlagService.isEnabled.mockResolvedValue(true);

      const result = await service.getDualWriteMetadata("cust-1");

      expect(result).toEqual({ dual_write: true });
    });

    it("should return undefined when dual-write is disabled", async () => {
      mockFeatureFlagService.isEnabled.mockResolvedValue(false);

      const result = await service.getDualWriteMetadata("cust-1");

      expect(result).toBeUndefined();
    });

    it("should log when metadata is attached", async () => {
      mockFeatureFlagService.isEnabled.mockResolvedValue(true);
      const logSpy = jest.spyOn(Logger.prototype, "log");

      await service.getDualWriteMetadata("cust-1");

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cust-1",
          action: "dual_write.metadata_attached",
        }),
      );
    });

    it("should return undefined and log error when flag lookup fails (H1 regression)", async () => {
      mockFeatureFlagService.isEnabled.mockRejectedValue(
        new Error("DB connection lost"),
      );
      const errorSpy = jest.spyOn(Logger.prototype, "error");

      const result = await service.getDualWriteMetadata("cust-1");

      expect(result).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cust-1",
          error: "DB connection lost",
          action: "dual_write.metadata_lookup_failed",
        }),
      );
    });
  });

  describe("logDualWriteFailure", () => {
    it("should log error and write to migration_logs via repository", async () => {
      const error = new Error("SQS timeout");
      const errorSpy = jest.spyOn(Logger.prototype, "error");

      await service.logDualWriteFailure(
        "cust-1",
        "payment.succeeded",
        { invoiceId: "inv-1" },
        error,
        "corr-123",
      );

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cust-1",
          operation: "payment.succeeded",
          error: "SQS timeout",
          action: "dual_write.secondary_failed",
          correlationId: "corr-123",
        }),
      );

      expect(mockMigrationLogsRepo.createLog).toHaveBeenCalledTimes(1);
      expect(mockMigrationLogsRepo.createLog).toHaveBeenCalledWith(
        expect.objectContaining({
          scriptName: "dual_write_failure",
          monolithCustomerId: "cust-1",
          status: "failed",
          errorMessage: "SQS timeout",
          details: {
            operation: "payment.succeeded",
            payload: { invoiceId: "inv-1" },
            correlationId: "corr-123",
          },
        }),
      );
    });

    it("should handle non-Error objects as error parameter", async () => {
      await service.logDualWriteFailure(
        "cust-1",
        "invoice.created",
        { invoiceId: "inv-2" },
        "string error",
        "corr-456",
      );

      expect(mockMigrationLogsRepo.createLog).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMessage: "string error",
        }),
      );
    });

    it("should catch and log migration_logs write failure without throwing", async () => {
      mockMigrationLogsRepo.createLog.mockRejectedValue(
        new Error("DB unavailable"),
      );
      const errorSpy = jest.spyOn(Logger.prototype, "error");

      await expect(
        service.logDualWriteFailure(
          "cust-1",
          "payment.succeeded",
          { invoiceId: "inv-1" },
          new Error("SQS failure"),
          "corr-789",
        ),
      ).resolves.toBeUndefined();

      // Should log both the dual-write failure and the migration_logs write failure
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Failed to log dual-write failure to migration_logs",
          originalError: "SQS failure",
          logError: "DB unavailable",
          customerId: "cust-1",
          operation: "payment.succeeded",
          correlationId: "corr-789",
        }),
      );
    });
  });
});
