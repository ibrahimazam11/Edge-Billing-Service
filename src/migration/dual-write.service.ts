import { Injectable, Logger } from "@nestjs/common";
import { FeatureFlagService } from "../feature-flags/feature-flags.service";
import { generateId } from "../common/utils/uuid.util";
import { MigrationLogsRepository } from "./migration-logs.repository";

@Injectable()
export class DualWriteService {
  private readonly logger = new Logger(DualWriteService.name);

  constructor(
    private readonly featureFlagService: FeatureFlagService,
    private readonly migrationLogsRepository: MigrationLogsRepository,
  ) {}

  async shouldDualWrite(customerId: string): Promise<boolean> {
    const [billingEnabled, dualWriteEnabled] = await Promise.all([
      this.featureFlagService.isEnabled(customerId, "billing_service_enabled"),
      this.featureFlagService.isEnabled(customerId, "dual_write_enabled"),
    ]);
    return billingEnabled && dualWriteEnabled;
  }

  async getDualWriteMetadata(
    customerId: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const enabled = await this.shouldDualWrite(customerId);
      if (enabled) {
        this.logger.log({
          customerId,
          action: "dual_write.metadata_attached",
        });
      }
      return enabled ? { dual_write: true } : undefined;
    } catch (error) {
      this.logger.error({
        customerId,
        error: error instanceof Error ? error.message : String(error),
        action: "dual_write.metadata_lookup_failed",
      });
      return undefined;
    }
  }

  async logDualWriteFailure(
    customerId: string,
    operation: string,
    payload: unknown,
    error: unknown,
    correlationId: string,
  ): Promise<void> {
    this.logger.error({
      customerId,
      operation,
      error: error instanceof Error ? error.message : String(error),
      action: "dual_write.secondary_failed",
      correlationId,
    });

    try {
      await this.migrationLogsRepository.createLog({
        id: generateId(),
        runId: correlationId,
        scriptName: "dual_write_failure",
        monolithCustomerId: customerId,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        details: { operation, payload, correlationId },
      });
    } catch (logError) {
      this.logger.error({
        message: "Failed to log dual-write failure to migration_logs",
        originalError: error instanceof Error ? error.message : String(error),
        logError:
          logError instanceof Error ? logError.message : String(logError),
        customerId,
        operation,
        correlationId,
      });
    }
  }
}
