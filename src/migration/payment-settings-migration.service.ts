import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Pool } from "pg";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { PAYMENT_GATEWAY } from "../gateway/gateway.interface";
import type { PaymentGateway } from "../gateway/gateway.interface";
import { customers } from "../database/schema/customers";
import { paymentMethods } from "../database/schema/payment-methods";
import { generateId } from "../common/utils/uuid.util";
import { CustomersRepository } from "../customers/customers.repository";
import { MigrationLogsRepository } from "./migration-logs.repository";
import { MONOLITH_DB_PROVIDER } from "./monolith-database.provider";
import type { MigrationOptions } from "./dto/migration-options.dto";
import type {
  MigrationResult,
  MigrationSummary,
} from "./dto/migration-result.dto";

interface MonolithPaymentSettings {
  Customer_ID: string;
  Stripe_Customer_ID: string;
  Payment_Method_Type: string;
  Mandate_ID: string | null;
}

@Injectable()
export class PaymentSettingsMigrationService {
  private readonly logger = new Logger(PaymentSettingsMigrationService.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    @Optional()
    @Inject(MONOLITH_DB_PROVIDER)
    private readonly monolithPool: Pool | null,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly customersRepository: CustomersRepository,
    private readonly migrationLogsRepository: MigrationLogsRepository,
  ) {}

  async migrateAll(options: MigrationOptions): Promise<MigrationSummary> {
    if (!this.monolithPool) {
      throw new Error(
        "Monolith database connection is not configured. Set MONOLITH_DATABASE_* environment variables.",
      );
    }

    const runId = generateId();
    const startTime = Date.now();
    const scriptName = options.dryRun
      ? "migrate-payment-settings-dry-run"
      : "migrate-payment-settings";

    this.logger.log({
      action: "migration.payment_settings.start",
      runId,
      dryRun: options.dryRun,
      batchSize: options.batchSize,
    });

    const result = await this.monolithPool.query<MonolithPaymentSettings>(
      'SELECT "Customer_ID", "Stripe_Customer_ID", "Payment_Method_Type", "Mandate_ID" FROM "Payment_Settings"',
    );

    const allCustomers = result.rows;
    const summary = await this.processBatches(
      allCustomers,
      runId,
      scriptName,
      options,
    );

    summary.duration = Date.now() - startTime;

    this.logger.log({
      action: "migration.payment_settings.complete",
      totalProcessed: summary.totalProcessed,
      succeeded: summary.succeeded,
      skipped: summary.skipped,
      failed: summary.failed,
      duration: summary.duration,
    });

    return summary;
  }

  async migrateByIds(
    monolithCustomerIds: string[],
    options: MigrationOptions,
  ): Promise<MigrationSummary> {
    if (!this.monolithPool) {
      throw new Error(
        "Monolith database connection is not configured. Set MONOLITH_DATABASE_* environment variables.",
      );
    }

    const runId = generateId();
    const startTime = Date.now();
    const scriptName = options.dryRun
      ? "migrate-payment-settings-dry-run"
      : "migrate-payment-settings";

    this.logger.log({
      action: "migration.payment_settings.start_by_ids",
      runId,
      dryRun: options.dryRun,
      customerCount: monolithCustomerIds.length,
    });

    const result = await this.monolithPool.query<MonolithPaymentSettings>(
      'SELECT "Customer_ID", "Stripe_Customer_ID", "Payment_Method_Type", "Mandate_ID" FROM "Payment_Settings" WHERE "Customer_ID" = ANY($1)',
      [monolithCustomerIds],
    );

    const allCustomers = result.rows;
    const summary = await this.processBatches(
      allCustomers,
      runId,
      scriptName,
      options,
    );

    summary.duration = Date.now() - startTime;

    this.logger.log({
      action: "migration.payment_settings.complete",
      totalProcessed: summary.totalProcessed,
      succeeded: summary.succeeded,
      skipped: summary.skipped,
      failed: summary.failed,
      duration: summary.duration,
    });

    return summary;
  }

  async migrateCustomer(
    monolithCustomerId: string,
    stripeCustomerId: string,
    paymentMethodType: string,
    mandateId: string | null,
    runId: string,
    options: MigrationOptions,
  ): Promise<MigrationResult> {
    const scriptName = options.dryRun
      ? "migrate-payment-settings-dry-run"
      : "migrate-payment-settings";

    try {
      // AC8: Idempotent — check if customer already exists
      const existing =
        await this.customersRepository.findByMonolithId(monolithCustomerId);

      if (existing) {
        const result: MigrationResult = {
          monolithCustomerId,
          billingCustomerId: existing.id,
          status: "skipped",
          reason: "already_migrated",
        };

        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          existing.id,
          "skipped",
          null,
          { reason: "already_migrated" },
        );

        this.logger.log({
          action: "migration.payment_settings.skip",
          monolithCustomerId,
          reason: "already_migrated",
        });

        return result;
      }

      // AC6: Stripe-before-DB — verify Stripe customer exists
      const stripeCustomer = await this.gateway.getCustomer(stripeCustomerId);

      // AC7: Sync payment methods from Stripe
      const stripePms = await this.gateway.listPaymentMethods(stripeCustomerId);

      // Determine default PM from the Stripe customer's invoice_settings
      const defaultPmId = stripeCustomer.defaultPaymentMethodId;

      if (options.dryRun) {
        // AC10: Dry-run — log planned actions without writing to billing DB
        const result: MigrationResult = {
          monolithCustomerId,
          status: "succeeded",
          reason: "dry_run",
          paymentMethodCount: stripePms.length,
        };

        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          null,
          "succeeded",
          null,
          {
            reason: "dry_run",
            paymentMethodCount: stripePms.length,
            stripeCustomerVerified: true,
            stripeEmail: stripeCustomer.email,
            stripeName: stripeCustomer.name,
            defaultPaymentMethodId: defaultPmId,
          },
        );

        this.logger.log({
          action: "migration.payment_settings.dry_run",
          monolithCustomerId,
          stripeCustomerId,
          paymentMethodCount: stripePms.length,
        });

        return result;
      }

      // Green path: create customer + payment methods in a transaction
      const billingCustomerId = generateId();

      await this.db.transaction(async (tx) => {
        // Insert customer
        await tx.insert(customers).values({
          id: billingCustomerId,
          monolithCustomerId,
          stripeCustomerId,
          name: stripeCustomer.name ?? monolithCustomerId,
          email: stripeCustomer.email,
          status: "active",
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // Insert payment methods synced from Stripe
        for (const pm of stripePms) {
          const mappedType = this.mapPaymentMethodType(pm.type);
          const isDefault = pm.id === defaultPmId;
          const isDefaultBankWithMandate =
            isDefault && mappedType === "bank_account" && mandateId;

          await tx.insert(paymentMethods).values({
            id: generateId(),
            customerId: billingCustomerId,
            stripePaymentMethodId: pm.id,
            type: mappedType,
            isDefault,
            lastFour: pm.last4,
            brand: pm.brand,
            bankName: pm.bankName,
            expiryMonth: pm.expiryMonth,
            expiryYear: pm.expiryYear,
            metadata: isDefaultBankWithMandate
              ? { mandate_id: mandateId }
              : null,
            status: "active",
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      });

      const result: MigrationResult = {
        monolithCustomerId,
        billingCustomerId,
        status: "succeeded",
        paymentMethodCount: stripePms.length,
      };

      await this.writeMigrationLog(
        runId,
        scriptName,
        monolithCustomerId,
        billingCustomerId,
        "succeeded",
        null,
        { paymentMethodCount: stripePms.length },
      );

      this.logger.log({
        action: "migration.payment_settings.success",
        monolithCustomerId,
        billingCustomerId,
        paymentMethodCount: stripePms.length,
      });

      return result;
    } catch (error) {
      // AC9: Individual failures do NOT abort the batch
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      try {
        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          null,
          "failed",
          errorMessage,
          { action: "migration.payment_settings" },
        );
      } catch (logError) {
        this.logger.error({
          action: "migration.payment_settings.log_write_failed",
          monolithCustomerId,
          logError:
            logError instanceof Error ? logError.message : String(logError),
        });
      }

      this.logger.error({
        action: "migration.payment_settings.fail",
        monolithCustomerId,
        error: errorMessage,
      });

      return {
        monolithCustomerId,
        status: "failed",
        reason: errorMessage,
      };
    }
  }

  private async processBatches(
    allCustomers: MonolithPaymentSettings[],
    runId: string,
    scriptName: string,
    options: MigrationOptions,
  ): Promise<MigrationSummary> {
    const summary: MigrationSummary = {
      runId,
      scriptName,
      totalProcessed: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      duration: 0,
    };

    const totalBatches = Math.ceil(allCustomers.length / options.batchSize);

    for (let i = 0; i < allCustomers.length; i += options.batchSize) {
      const batch = allCustomers.slice(i, i + options.batchSize);
      const batchNumber = Math.floor(i / options.batchSize) + 1;

      for (const row of batch) {
        const result = await this.migrateCustomer(
          row.Customer_ID,
          row.Stripe_Customer_ID,
          row.Payment_Method_Type,
          row.Mandate_ID,
          runId,
          options,
        );

        summary.totalProcessed++;
        if (result.status === "succeeded") summary.succeeded++;
        else if (result.status === "skipped") summary.skipped++;
        else if (result.status === "failed") summary.failed++;
      }

      this.logger.log({
        action: "migration.payment_settings.batch_progress",
        batchNumber,
        totalBatches,
        processed: summary.totalProcessed,
        remaining: allCustomers.length - summary.totalProcessed,
      });

      // AC11: Batch delay between batches (skip after last batch)
      if (i + options.batchSize < allCustomers.length) {
        await this.sleep(options.batchDelayMs);
      }
    }

    return summary;
  }

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

  private mapPaymentMethodType(stripeType: string): string {
    if (stripeType === "us_bank_account") return "bank_account";
    if (stripeType === "card") return "card";
    return stripeType;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
