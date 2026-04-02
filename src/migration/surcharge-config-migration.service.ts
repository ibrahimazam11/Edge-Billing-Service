import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Pool } from "pg";
import { generateId } from "../common/utils/uuid.util";
import { CustomersRepository } from "../customers/customers.repository";
import { SurchargeConfigRepository } from "../surcharges/surcharge-config.repository";
import { SurchargeConfigService } from "../surcharges/surcharge-config.service";
import { MigrationLogsRepository } from "./migration-logs.repository";
import { MONOLITH_DB_PROVIDER } from "./monolith-database.provider";
import type { MigrationOptions } from "./dto/migration-options.dto";

// --- Monolith data interface (Task 1.2) ---

export interface MonolithCustomerCreditCardSettings {
  Customer_ID: string;
  Allow_Credit_Card: boolean | null;
  Surcharge_Type: string | null;
  Surcharge_Value: string | null; // numeric(10,2) as string
  Reason: string | null;
  Notes: string | null;
  Enabled_By_User_ID: string | null;
}

// --- Migration result types ---

export interface SurchargeConfigMigrationResult {
  monolithCustomerId: string;
  billingCustomerId?: string;
  status: "succeeded" | "skipped" | "failed";
  reason?: string;
  surchargeType?: string | null;
}

export interface SurchargeConfigMigrationSummary {
  runId: string;
  scriptName: string;
  totalConfigs: number;
  succeeded: number;
  skipped: number;
  failed: number;
  percentageType: number;
  flatFeeType: number;
  duration: number;
}

// --- Helper functions ---

export function convertSurchargeValue(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return null;
  // Both percentage and flat_fee: Math.round(value * 100)
  // percentage: 3.50 -> 350 basis points
  // flat_fee: 5.00 -> 500 cents
  return Math.round(num * 100);
}

export function mapSurchargeType(
  monolithType: string | null,
): "percentage" | "flat_fee" | null {
  if (!monolithType) return null;
  const normalized = monolithType.toLowerCase().trim();
  switch (normalized) {
    case "percentage":
      return "percentage";
    case "flat":
    case "flat_fee":
      return "flat_fee";
    default:
      return null;
  }
}

@Injectable()
export class SurchargeConfigMigrationService {
  private readonly logger = new Logger(SurchargeConfigMigrationService.name);

  constructor(
    @Optional()
    @Inject(MONOLITH_DB_PROVIDER)
    private readonly monolithPool: Pool | null,
    private readonly customersRepository: CustomersRepository,
    private readonly surchargeConfigRepository: SurchargeConfigRepository,
    private readonly surchargeConfigService: SurchargeConfigService,
    private readonly migrationLogsRepository: MigrationLogsRepository,
  ) {}

  // --- Monolith query helper (Task 1.4) ---

  async fetchCreditCardSettings(
    monolithCustomerId: string,
  ): Promise<MonolithCustomerCreditCardSettings | null> {
    if (!this.monolithPool) {
      throw new Error(
        "Monolith database connection is not configured. Set MONOLITH_DATABASE_* environment variables.",
      );
    }

    const result =
      await this.monolithPool.query<MonolithCustomerCreditCardSettings>(
        `SELECT "Customer_ID", "Allow_Credit_Card", "Surcharge_Type",
                "Surcharge_Value", "Reason", "Notes", "Enabled_By_User_ID"
         FROM "Customer_Credit_Card_Settings"
         WHERE "Customer_ID" = $1`,
        [monolithCustomerId],
      );

    return result.rows[0] ?? null;
  }

  async fetchAllCreditCardSettings(): Promise<
    MonolithCustomerCreditCardSettings[]
  > {
    if (!this.monolithPool) {
      throw new Error(
        "Monolith database connection is not configured. Set MONOLITH_DATABASE_* environment variables.",
      );
    }

    const result =
      await this.monolithPool.query<MonolithCustomerCreditCardSettings>(
        `SELECT "Customer_ID", "Allow_Credit_Card", "Surcharge_Type",
                "Surcharge_Value", "Reason", "Notes", "Enabled_By_User_ID"
         FROM "Customer_Credit_Card_Settings"`,
      );

    return result.rows;
  }

  // --- Main migration methods (Task 4.2, 4.3) ---

  async migrateAll(
    options: MigrationOptions,
  ): Promise<SurchargeConfigMigrationSummary> {
    if (!this.monolithPool) {
      throw new Error(
        "Monolith database connection is not configured. Set MONOLITH_DATABASE_* environment variables.",
      );
    }

    const runId = generateId();
    const startTime = Date.now();
    const scriptName = options.dryRun
      ? "migrate-surcharge-configs-dry-run"
      : "migrate-surcharge-configs";

    this.logger.log({
      action: "migration.surcharge_config.start",
      runId,
      dryRun: options.dryRun,
    });

    // Get all migrated customers
    const migratedCustomers =
      await this.customersRepository.findAllForMigration();

    const customerMap = new Map(
      migratedCustomers.map((c) => [c.monolithCustomerId, c.id]),
    );

    const summary: SurchargeConfigMigrationSummary = {
      runId,
      scriptName,
      totalConfigs: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      percentageType: 0,
      flatFeeType: 0,
      duration: 0,
    };

    // Fetch all settings from monolith
    const allSettings = await this.fetchAllCreditCardSettings();

    for (const settings of allSettings) {
      const billingCustomerId = customerMap.get(settings.Customer_ID);
      if (!billingCustomerId) {
        this.logger.warn({
          action: "migration.surcharge_config.customer_not_found",
          monolithCustomerId: settings.Customer_ID,
        });
        summary.totalConfigs++;
        summary.failed++;
        await this.writeMigrationLog(
          runId,
          scriptName,
          settings.Customer_ID,
          null,
          "failed",
          "Customer not found in billing DB",
          { reason: "customer_not_found" },
        );
        continue;
      }

      const result = await this.migrateSingleConfig(
        settings,
        billingCustomerId,
        runId,
        scriptName,
        options,
      );

      summary.totalConfigs++;
      if (result.status === "succeeded") {
        summary.succeeded++;
        if (result.surchargeType === "percentage") {
          summary.percentageType++;
        } else if (result.surchargeType === "flat_fee") {
          summary.flatFeeType++;
        }
      } else if (result.status === "skipped") {
        summary.skipped++;
      } else {
        summary.failed++;
      }
    }

    summary.duration = Date.now() - startTime;

    this.logger.log({
      action: "migration.surcharge_config.complete",
      ...this.summaryToLog(summary),
    });

    return summary;
  }

  async migrateByIds(
    monolithCustomerIds: string[],
    options: MigrationOptions,
  ): Promise<SurchargeConfigMigrationSummary> {
    if (!this.monolithPool) {
      throw new Error(
        "Monolith database connection is not configured. Set MONOLITH_DATABASE_* environment variables.",
      );
    }

    const runId = generateId();
    const startTime = Date.now();
    const scriptName = options.dryRun
      ? "migrate-surcharge-configs-dry-run"
      : "migrate-surcharge-configs";

    this.logger.log({
      action: "migration.surcharge_config.start_by_ids",
      runId,
      dryRun: options.dryRun,
      customerCount: monolithCustomerIds.length,
    });

    const summary: SurchargeConfigMigrationSummary = {
      runId,
      scriptName,
      totalConfigs: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      percentageType: 0,
      flatFeeType: 0,
      duration: 0,
    };

    for (const monolithId of monolithCustomerIds) {
      const customer =
        await this.customersRepository.findByMonolithId(monolithId);

      if (!customer) {
        this.logger.warn({
          action: "migration.surcharge_config.customer_not_found",
          monolithCustomerId: monolithId,
        });
        summary.totalConfigs++;
        summary.failed++;
        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithId,
          null,
          "failed",
          "Customer not found in billing DB",
          { reason: "customer_not_found" },
        );
        continue;
      }

      const settings = await this.fetchCreditCardSettings(monolithId);
      if (!settings) {
        this.logger.log({
          action: "migration.surcharge_config.no_settings",
          monolithCustomerId: monolithId,
        });
        continue; // No config to migrate — not counted
      }

      const result = await this.migrateSingleConfig(
        settings,
        customer.id,
        runId,
        scriptName,
        options,
      );

      summary.totalConfigs++;
      if (result.status === "succeeded") {
        summary.succeeded++;
        if (result.surchargeType === "percentage") {
          summary.percentageType++;
        } else if (result.surchargeType === "flat_fee") {
          summary.flatFeeType++;
        }
      } else if (result.status === "skipped") {
        summary.skipped++;
      } else {
        summary.failed++;
      }
    }

    summary.duration = Date.now() - startTime;

    this.logger.log({
      action: "migration.surcharge_config.complete",
      ...this.summaryToLog(summary),
    });

    return summary;
  }

  // --- Per-config migration (Task 4.4) ---

  async migrateSingleConfig(
    settings: MonolithCustomerCreditCardSettings,
    billingCustomerId: string,
    runId: string,
    scriptName: string,
    options: MigrationOptions,
  ): Promise<SurchargeConfigMigrationResult> {
    const monolithCustomerId = settings.Customer_ID;

    try {
      // AC11: Idempotency check — existing surcharge_configs for customer
      const existing =
        await this.surchargeConfigRepository.findByCustomer(billingCustomerId);

      if (existing) {
        const result: SurchargeConfigMigrationResult = {
          monolithCustomerId,
          billingCustomerId,
          status: "skipped",
          reason: "already_migrated",
        };

        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          billingCustomerId,
          "skipped",
          null,
          { reason: "already_migrated" },
        );

        return result;
      }

      // AC10: Type and value conversion
      const surchargeType = mapSurchargeType(settings.Surcharge_Type);
      const surchargeValue = convertSurchargeValue(settings.Surcharge_Value);

      if (settings.Surcharge_Type && !surchargeType) {
        this.logger.warn({
          action: "migration.surcharge_config.unknown_type",
          monolithCustomerId,
          originalType: settings.Surcharge_Type,
        });
      }

      // AC12: Dry-run mode
      if (options.dryRun) {
        const result: SurchargeConfigMigrationResult = {
          monolithCustomerId,
          billingCustomerId,
          status: "succeeded",
          reason: "dry_run",
          surchargeType,
        };

        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          billingCustomerId,
          "succeeded",
          null,
          {
            reason: "dry_run",
            allowCreditCard: settings.Allow_Credit_Card,
            surchargeType,
            surchargeValue,
          },
        );

        return result;
      }

      // Use SurchargeConfigService.upsertConfig() for write
      await this.surchargeConfigService.upsertConfig(billingCustomerId, {
        allowCreditCard: settings.Allow_Credit_Card ?? false,
        surchargeType: surchargeType ?? undefined,
        surchargeValue: surchargeValue ?? undefined,
        reason: settings.Reason ?? undefined,
        notes: settings.Notes ?? undefined,
        enabledBy: settings.Enabled_By_User_ID ?? undefined,
      });

      await this.writeMigrationLog(
        runId,
        scriptName,
        monolithCustomerId,
        billingCustomerId,
        "succeeded",
        null,
        {
          allowCreditCard: settings.Allow_Credit_Card,
          surchargeType,
          surchargeValue,
        },
      );

      return {
        monolithCustomerId,
        billingCustomerId,
        status: "succeeded" as const,
        surchargeType,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      try {
        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          billingCustomerId,
          "failed",
          errorMessage,
          { action: "migration.surcharge_config" },
        );
      } catch (logError) {
        this.logger.error({
          action: "migration.surcharge_config.log_write_failed",
          monolithCustomerId,
          logError:
            logError instanceof Error ? logError.message : String(logError),
        });
      }

      this.logger.error({
        action: "migration.surcharge_config.fail",
        monolithCustomerId,
        error: errorMessage,
      });

      return {
        monolithCustomerId,
        billingCustomerId,
        status: "failed" as const,
        reason: errorMessage,
      };
    }
  }

  // --- Utility methods ---

  private async writeMigrationLog(
    runId: string,
    scriptName: string,
    monolithCustomerId: string,
    billingCustomerId: string | null,
    status: string,
    errorMessage: string | null,
    details: Record<string, unknown> | null,
  ): Promise<void> {
    await this.migrationLogsRepository.createLog({
      id: generateId(),
      runId,
      scriptName,
      monolithCustomerId,
      billingCustomerId,
      status,
      errorMessage,
      details,
      createdAt: new Date(),
    });
  }

  private summaryToLog(
    summary: SurchargeConfigMigrationSummary,
  ): Record<string, unknown> {
    return {
      totalConfigs: summary.totalConfigs,
      succeeded: summary.succeeded,
      skipped: summary.skipped,
      failed: summary.failed,
      percentageType: summary.percentageType,
      flatFeeType: summary.flatFeeType,
      duration: summary.duration,
    };
  }
}
