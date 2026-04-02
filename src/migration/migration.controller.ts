import { Controller, Get, Logger, Query } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiUnauthorizedResponse,
  ApiQuery,
} from "@nestjs/swagger";
import { CustomersRepository } from "../customers/customers.repository";
import { FeatureFlagService } from "../feature-flags/feature-flags.service";
import { FeatureFlagsRepository } from "../feature-flags/feature-flags.repository";
import { MigrationLogsRepository } from "./migration-logs.repository";
import type {
  CustomerMigrationStatus,
  AggregateMigrationStatus,
  MigrationStatusResponse,
} from "./dto/migration-status.dto";

@ApiTags("Migration")
@ApiUnauthorizedResponse({ description: "Unauthorized" })
@Controller("v1/migration")
export class MigrationController {
  private readonly logger = new Logger(MigrationController.name);

  constructor(
    private readonly customersRepository: CustomersRepository,
    private readonly migrationLogsRepository: MigrationLogsRepository,
    private readonly featureFlagsRepository: FeatureFlagsRepository,
    private readonly featureFlagService: FeatureFlagService,
  ) {}

  @Get("status")
  @ApiOperation({ summary: "Get migration status" })
  @ApiQuery({
    name: "customerId",
    required: false,
    description:
      "Customer UUID — if provided returns customer-level status, otherwise aggregate",
  })
  @ApiOkResponse({
    schema: {
      oneOf: [
        {
          properties: {
            type: { type: "string", enum: ["customer"] },
            data: {
              type: "object",
              properties: {
                customerId: { type: "string" },
                migrationStatus: {
                  type: "string",
                  enum: ["migrated", "pending", "failed"],
                },
                dualWriteEnabled: { type: "boolean" },
                billingServiceEnabled: { type: "boolean" },
                lastMigrationScript: { type: "string", nullable: true },
                lastMigrationDate: { type: "string", nullable: true },
                errorMessage: { type: "string", nullable: true },
              },
            },
          },
        },
        {
          properties: {
            type: { type: "string", enum: ["aggregate"] },
            data: {
              type: "object",
              properties: {
                totalCustomers: { type: "number" },
                migrated: { type: "number" },
                pending: { type: "number" },
                failed: { type: "number" },
                dualWriteActive: { type: "number" },
              },
            },
          },
        },
      ],
    },
  })
  async getStatus(
    @Query("customerId") customerId?: string,
  ): Promise<MigrationStatusResponse> {
    if (customerId) {
      return this.getCustomerMigrationStatus(customerId);
    }
    return this.getAggregateMigrationStatus();
  }

  private async getCustomerMigrationStatus(
    customerId: string,
  ): Promise<MigrationStatusResponse> {
    const customer = await this.customersRepository.findById(customerId);

    let migrationStatus: "migrated" | "pending" | "failed" = "pending";
    let lastScript: string | null = null;
    let lastDate: string | null = null;
    let errorMessage: string | null = null;

    if (customer) {
      const latestLog =
        await this.migrationLogsRepository.findLatestByMonolithCustomerId(
          customer.monolithCustomerId,
        );

      if (latestLog) {
        lastScript = latestLog.scriptName;
        lastDate = latestLog.createdAt.toISOString();
        errorMessage = latestLog.errorMessage;
        migrationStatus = latestLog.status === "failed" ? "failed" : "migrated";
      }
    }

    // Get feature flag states
    const [billingEnabled, dualWriteEnabled] = await Promise.all([
      this.featureFlagService.isEnabled(customerId, "billing_service_enabled"),
      this.featureFlagService.isEnabled(customerId, "dual_write_enabled"),
    ]);

    const data: CustomerMigrationStatus = {
      customerId,
      migrationStatus,
      dualWriteEnabled,
      billingServiceEnabled: billingEnabled,
      lastMigrationScript: lastScript,
      lastMigrationDate: lastDate,
      errorMessage,
    };

    this.logger.log({
      customerId,
      migrationStatus,
      dualWriteEnabled,
      action: "migration.status_queried",
    });

    return { type: "customer", data };
  }

  private async getAggregateMigrationStatus(): Promise<MigrationStatusResponse> {
    const totalCustomers =
      await this.customersRepository.countMonolithCustomers();

    const migStats =
      await this.migrationLogsRepository.getAggregateMigrationStats();
    const migrated = migStats.migrated;
    const failed = migStats.failed;

    const dualWriteActive =
      await this.featureFlagsRepository.countEnabledByFlagName(
        "dual_write_enabled",
      );

    const data: AggregateMigrationStatus = {
      totalCustomers,
      migrated,
      pending: totalCustomers - migrated - failed,
      failed,
      dualWriteActive,
    };

    this.logger.log({
      ...data,
      action: "migration.aggregate_status_queried",
    });

    return { type: "aggregate", data };
  }
}
