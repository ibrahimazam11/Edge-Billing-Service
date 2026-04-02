import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Pool } from "pg";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { invoices } from "../database/schema/invoices";
import { invoiceLineItems } from "../database/schema/invoice-line-items";
import { charges } from "../database/schema/charges";
import { migrationLogs } from "../database/schema/migration-logs";

import { generateId } from "../common/utils/uuid.util";
import { CustomersRepository } from "../customers/customers.repository";
import { PaymentMethodsRepository } from "../payment-methods/payment-methods.repository";
import { SubscriptionsRepository } from "../subscriptions/subscriptions.repository";
import { InvoicesRepository } from "../invoices/invoices.repository";
import { LedgerService } from "../ledger/ledger.service";
import { MigrationLogsRepository } from "./migration-logs.repository";
import { MONOLITH_DB_PROVIDER } from "./monolith-database.provider";
import { dollarsToCents } from "./charges-migration.service";
import type { MigrationOptions } from "./dto/migration-options.dto";

// --- Monolith data interfaces (Task 1) ---

export interface MonolithCustomerPayroll {
  Customer_Payroll_ID: string;
  Customer_ID: string | null;
  Total_Amount: string | null; // numeric comes as string from pg
  Total_Bonus: string | null;
  Payment_Date: Date | null;
  Paid_On: Date | null;
  Status: string | null;
  Payroll_Month: Date | string | null;
  Credit_Card_Surcharge: string | null;
  Failure: boolean | string | null;
  Failure_Date: Date | null;
  Failure_Reason: string | null;
  Payment_Method: string | null;
  Reference_Number: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  Invoice_ID: string | null;
}

// --- Payroll migration result types ---

export interface PayrollMigrationResult {
  monolithPayrollId: string;
  monolithCustomerId: string;
  billingCustomerId?: string;
  invoiceId?: string;
  chargeId?: string;
  status: "succeeded" | "skipped" | "failed";
  reason?: string;
  lineItemCount?: number;
  ledgerPairCount?: number;
  conversionWarnings?: number;
}

export interface PayrollMigrationSummary {
  runId: string;
  scriptName: string;
  totalPayrolls: number;
  succeeded: number;
  skipped: number;
  failed: number;
  orphanedSkipped: number;
  nullAmountSkipped: number;
  ledgerPairsCreated: number;
  conversionWarnings: number;
  duration: number;
}

// --- Helper functions ---

export function mapPayrollStatus(payroll: MonolithCustomerPayroll): {
  invoiceStatus: string;
  createCharge: boolean;
  chargeStatus?: string;
} | null {
  // Failure boolean flag overrides Status string
  if (payroll.Failure === true || payroll.Failure === "true") {
    return {
      invoiceStatus: "finalized",
      createCharge: true,
      chargeStatus: "failed",
    };
  }

  const normalized = payroll.Status?.toLowerCase().trim();
  switch (normalized) {
    case "paid":
    case "succeeded":
      return {
        invoiceStatus: "paid",
        createCharge: true,
        chargeStatus: "succeeded",
      };
    case "failed":
      return {
        invoiceStatus: "finalized",
        createCharge: true,
        chargeStatus: "failed",
      };
    case "pending":
    case "processing":
      return {
        invoiceStatus: "finalized",
        createCharge: true,
        chargeStatus: "pending",
      };
    default:
      return null; // Unknown — skip with warning
  }
}

export function deriveBillingPeriod(payrollMonth: Date | string): {
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
} {
  const date = new Date(payrollMonth);
  const start = new Date(Date.UTC(date.getFullYear(), date.getMonth(), 1));
  const end = new Date(Date.UTC(date.getFullYear(), date.getMonth() + 1, 1));
  return { billingPeriodStart: start, billingPeriodEnd: end };
}

export function mapPaymentMethodType(
  monolithType: string | null,
): string | null {
  if (!monolithType) return null;
  const normalized = monolithType.toLowerCase().trim();
  switch (normalized) {
    case "ach":
      return "bank_account";
    case "credit_card":
    case "card":
    case "visa":
    case "mastercard":
    case "amex":
      return "card";
    default:
      return null;
  }
}

@Injectable()
export class PayrollBillingMigrationService {
  private readonly logger = new Logger(PayrollBillingMigrationService.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    @Optional()
    @Inject(MONOLITH_DB_PROVIDER)
    private readonly monolithPool: Pool | null,
    private readonly customersRepository: CustomersRepository,
    private readonly paymentMethodsRepository: PaymentMethodsRepository,
    private readonly subscriptionsRepository: SubscriptionsRepository,
    private readonly invoicesRepository: InvoicesRepository,
    private readonly ledgerService: LedgerService,
    private readonly migrationLogsRepository: MigrationLogsRepository,
  ) {}

  // --- Monolith query helpers (Task 1.3) ---

  async fetchPayrollForCustomer(
    monolithCustomerId: string,
  ): Promise<MonolithCustomerPayroll[]> {
    if (!this.monolithPool) {
      throw new Error(
        "Monolith database connection is not configured. Set MONOLITH_DATABASE_* environment variables.",
      );
    }

    const result = await this.monolithPool.query<MonolithCustomerPayroll>(
      `SELECT "Customer_Payroll_ID", "Customer_ID", "Total_Amount", "Total_Bonus",
              "Payment_Date", "Paid_On", "Status", "Payroll_Month",
              "Credit_Card_Surcharge", "Failure", "Failure_Date", "Failure_Reason",
              "Payment_Method", "Reference_Number", "createdBy", "updatedBy",
              "Invoice_ID"
       FROM "Customer_Payroll"
       WHERE "Customer_ID" = $1
       ORDER BY "Payroll_Month" ASC`,
      [monolithCustomerId],
    );

    return result.rows;
  }

  async fetchOrphanedPayrollCount(): Promise<number> {
    if (!this.monolithPool) return 0;

    const result = await this.monolithPool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM "Customer_Payroll" WHERE "Customer_ID" IS NULL`,
    );

    return parseInt(result.rows[0].count, 10);
  }

  // --- Main migration methods (Task 2.2, 2.3) ---

  async migrateAll(
    options: MigrationOptions,
  ): Promise<PayrollMigrationSummary> {
    if (!this.monolithPool) {
      throw new Error(
        "Monolith database connection is not configured. Set MONOLITH_DATABASE_* environment variables.",
      );
    }

    const runId = generateId();
    const startTime = Date.now();
    const scriptName = options.dryRun
      ? "migrate-payroll-billing-dry-run"
      : "migrate-payroll-billing";

    this.logger.log({
      action: "migration.payroll.start",
      runId,
      dryRun: options.dryRun,
      batchSize: options.batchSize,
    });

    // Get all migrated customers (have monolith_customer_id in billing DB)
    const migratedCustomers =
      await this.customersRepository.findAllForMigration();

    // Count orphaned records (null Customer_ID) for summary
    const orphanedCount = await this.fetchOrphanedPayrollCount();

    const summary = await this.processBatches(
      migratedCustomers,
      runId,
      scriptName,
      options,
    );

    summary.orphanedSkipped += orphanedCount;
    summary.duration = Date.now() - startTime;

    this.logger.log({
      action: "migration.payroll.complete",
      ...this.summaryToLog(summary),
    });

    return summary;
  }

  async migrateByIds(
    monolithCustomerIds: string[],
    options: MigrationOptions,
  ): Promise<PayrollMigrationSummary> {
    if (!this.monolithPool) {
      throw new Error(
        "Monolith database connection is not configured. Set MONOLITH_DATABASE_* environment variables.",
      );
    }

    const runId = generateId();
    const startTime = Date.now();
    const scriptName = options.dryRun
      ? "migrate-payroll-billing-dry-run"
      : "migrate-payroll-billing";

    this.logger.log({
      action: "migration.payroll.start_by_ids",
      runId,
      dryRun: options.dryRun,
      customerCount: monolithCustomerIds.length,
    });

    const migratedCustomers: { id: string; monolithCustomerId: string }[] = [];
    for (const monolithId of monolithCustomerIds) {
      const customer =
        await this.customersRepository.findByMonolithId(monolithId);

      if (customer) {
        migratedCustomers.push(customer);
      } else {
        this.logger.warn({
          action: "migration.payroll.customer_not_found",
          monolithCustomerId: monolithId,
        });
      }
    }

    const summary = await this.processBatches(
      migratedCustomers,
      runId,
      scriptName,
      options,
    );

    summary.duration = Date.now() - startTime;

    this.logger.log({
      action: "migration.payroll.complete",
      ...this.summaryToLog(summary),
    });

    return summary;
  }

  // --- Per-customer migration (Task 2.4) ---

  async migratePayrollForCustomer(
    billingCustomerId: string,
    monolithCustomerId: string,
    runId: string,
    scriptName: string,
    options: MigrationOptions,
  ): Promise<PayrollMigrationResult[]> {
    const results: PayrollMigrationResult[] = [];

    const payrolls = await this.fetchPayrollForCustomer(monolithCustomerId);

    // Payment method lookup with type matching and isDefault filter (AC8)
    const customerPMs =
      await this.paymentMethodsRepository.findAllByCustomerUnfiltered(
        billingCustomerId,
      );

    // Subscription alignment check (AC9)
    await this.checkSubscriptionAlignment(
      billingCustomerId,
      monolithCustomerId,
      payrolls,
    );

    for (const payroll of payrolls) {
      const result = await this.migrateSinglePayroll(
        payroll,
        billingCustomerId,
        monolithCustomerId,
        customerPMs,
        runId,
        scriptName,
        options,
      );

      results.push(result);
    }

    return results;
  }

  // --- Per-payroll migration (Task 2.5) ---

  async migrateSinglePayroll(
    payroll: MonolithCustomerPayroll,
    billingCustomerId: string,
    monolithCustomerId: string,
    customerPMs: Array<{
      id: string;
      type: string;
      isDefault: boolean;
    }>,
    runId: string,
    scriptName: string,
    options: MigrationOptions,
  ): Promise<PayrollMigrationResult> {
    const payrollId = payroll.Customer_Payroll_ID;

    try {
      // AC2: Nullable Customer_ID → skip (orphaned record)
      if (!payroll.Customer_ID) {
        const result: PayrollMigrationResult = {
          monolithPayrollId: payrollId,
          monolithCustomerId,
          billingCustomerId,
          status: "skipped",
          reason: "orphaned_no_customer_id",
        };

        this.logger.log({
          action: "migration.payroll.orphaned_skip",
          payrollId,
        });

        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          billingCustomerId,
          "skipped",
          null,
          { payrollId, reason: "orphaned_no_customer_id" },
        );

        return result;
      }

      // AC3: Nullable Total_Amount → skip
      const totalCents = dollarsToCents(payroll.Total_Amount);
      if (totalCents === null) {
        const result: PayrollMigrationResult = {
          monolithPayrollId: payrollId,
          monolithCustomerId,
          billingCustomerId,
          status: "skipped",
          reason: "null_amount",
        };

        this.logger.log({
          action: "migration.payroll.null_amount_skip",
          payrollId,
          customerId: monolithCustomerId,
        });

        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          billingCustomerId,
          "skipped",
          null,
          { payrollId, reason: "null_amount" },
        );

        return result;
      }

      // AC5: Payment status mapping
      const statusMapping = mapPayrollStatus(payroll);
      if (!statusMapping) {
        const result: PayrollMigrationResult = {
          monolithPayrollId: payrollId,
          monolithCustomerId,
          billingCustomerId,
          status: "skipped",
          reason: "unknown_status",
        };

        this.logger.warn({
          action: "migration.payroll.unknown_status",
          payrollId,
          originalStatus: payroll.Status,
        });

        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          billingCustomerId,
          "skipped",
          null,
          {
            payrollId,
            reason: "unknown_status",
            originalStatus: payroll.Status,
          },
        );

        return result;
      }

      // AC11: Idempotency check by monolith_payroll_id in metadata
      const existing = await this.invoicesRepository.findByMonolithMetadata(
        "monolith_payroll_id",
        payrollId,
      );

      if (existing) {
        const result: PayrollMigrationResult = {
          monolithPayrollId: payrollId,
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
          { payrollId, reason: "already_migrated" },
        );

        return result;
      }

      // AC8: Payment method lookup
      const paymentMethodId = this.findPaymentMethod(
        payroll,
        customerPMs,
        billingCustomerId,
        monolithCustomerId,
      );

      if (statusMapping.createCharge && !paymentMethodId) {
        const result: PayrollMigrationResult = {
          monolithPayrollId: payrollId,
          monolithCustomerId,
          billingCustomerId,
          status: "failed",
          reason: "no_payment_method",
        };

        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          billingCustomerId,
          "failed",
          "No payment method found for customer",
          { payrollId, reason: "no_payment_method" },
        );

        return result;
      }

      // AC4: Billing period derivation
      if (!payroll.Payroll_Month) {
        const result: PayrollMigrationResult = {
          monolithPayrollId: payrollId,
          monolithCustomerId,
          billingCustomerId,
          status: "failed",
          reason: "no_payroll_month",
        };

        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          billingCustomerId,
          "failed",
          "Payroll_Month is null",
          { payrollId, reason: "no_payroll_month" },
        );

        return result;
      }

      const { billingPeriodStart, billingPeriodEnd } = deriveBillingPeriod(
        payroll.Payroll_Month,
      );

      // AC6: Line item decomposition
      const invoiceId = generateId();
      const { items: builtLineItems, warnings: lineItemWarnings } =
        this.buildPayrollLineItems(payroll, totalCents, invoiceId);

      // M4: totalAmountCents from line item sum
      const invoiceTotalCents = builtLineItems.reduce(
        (sum, item) => sum + item.amountCents,
        0,
      );

      const dueDate = payroll.Payment_Date ?? billingPeriodStart;

      // AC12: Dry-run mode
      if (options.dryRun) {
        const result: PayrollMigrationResult = {
          monolithPayrollId: payrollId,
          monolithCustomerId,
          billingCustomerId,
          status: "succeeded",
          reason: "dry_run",
          lineItemCount: builtLineItems.length,
          ledgerPairCount: this.getLedgerPairCount(statusMapping),
          conversionWarnings: lineItemWarnings,
        };

        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          billingCustomerId,
          "succeeded",
          null,
          {
            payrollId,
            reason: "dry_run",
            invoiceStatus: statusMapping.invoiceStatus,
            lineItemCount: builtLineItems.length,
            totalCents: invoiceTotalCents,
          },
        );

        return result;
      }

      // --- Real migration within a transaction ---
      let createdChargeId: string | undefined;
      let ledgerPairCount = 0;

      await this.db.transaction(async (tx) => {
        // 1. Insert invoice with metadata containing monolith_payroll_id
        await tx.insert(invoices).values({
          id: invoiceId,
          customerId: billingCustomerId,
          subscriptionId: null,
          status: statusMapping.invoiceStatus,
          totalAmountCents: invoiceTotalCents,
          currency: "usd",
          billingPeriodStart,
          billingPeriodEnd,
          dueDate,
          paidAt:
            statusMapping.invoiceStatus === "paid"
              ? (payroll.Paid_On ?? payroll.Payment_Date ?? dueDate)
              : null,
          voidedAt: null,
          metadata: {
            monolith_payroll_id: payrollId,
            ...(payroll.Reference_Number
              ? { reference_number: payroll.Reference_Number }
              : {}),
            ...(payroll.createdBy ? { created_by: payroll.createdBy } : {}),
            ...(payroll.updatedBy ? { updated_by: payroll.updatedBy } : {}),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // 2. Insert invoice line items
        for (const item of builtLineItems) {
          await tx.insert(invoiceLineItems).values(item);
        }

        // 3. Insert charge record (if paid/failed/pending)
        if (statusMapping.createCharge && paymentMethodId) {
          createdChargeId = generateId();
          await tx.insert(charges).values({
            id: createdChargeId,
            invoiceId,
            customerId: billingCustomerId,
            paymentMethodId,
            amountCents: invoiceTotalCents,
            currency: "usd",
            status: statusMapping.chargeStatus!,
            stripePaymentIntentId: null,
            idempotencyKey: `mig_payroll_${payrollId}`,
            failureReason: payroll.Failure_Reason ?? null,
            attemptNumber: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }

        // 4. Insert ledger entries via LedgerService (AC7)
        const correlationId = `migration-${runId}`;

        if (
          statusMapping.invoiceStatus === "paid" ||
          statusMapping.invoiceStatus === "finalized"
        ) {
          await this.ledgerService.recordMigrationPayrollFinalized(
            invoiceId,
            invoiceTotalCents,
            "usd",
            payrollId,
            correlationId,
            tx,
          );
          ledgerPairCount++;
        }

        if (statusMapping.invoiceStatus === "paid") {
          await this.ledgerService.recordMigrationPayrollPayment(
            invoiceId,
            invoiceTotalCents,
            "usd",
            payrollId,
            correlationId,
            tx,
          );
          ledgerPairCount++;
        }

        // 5. Insert migration log within transaction
        await tx.insert(migrationLogs).values({
          id: generateId(),
          runId,
          scriptName,
          monolithCustomerId,
          billingCustomerId,
          status: "succeeded",
          errorMessage: null,
          details: {
            payrollId,
            invoiceId,
            chargeRecordId: createdChargeId ?? null,
            invoiceStatus: statusMapping.invoiceStatus,
            lineItemCount: builtLineItems.length,
            ledgerPairCount,
            totalCents: invoiceTotalCents,
          },
          createdAt: new Date(),
        });
      });

      return {
        monolithPayrollId: payrollId,
        monolithCustomerId,
        billingCustomerId,
        invoiceId,
        chargeId: createdChargeId,
        status: "succeeded" as const,
        lineItemCount: builtLineItems.length,
        ledgerPairCount,
        conversionWarnings: lineItemWarnings,
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
          { payrollId, action: "migration.payroll" },
        );
      } catch (logError) {
        this.logger.error({
          action: "migration.payroll.log_write_failed",
          payrollId,
          logError:
            logError instanceof Error ? logError.message : String(logError),
        });
      }

      this.logger.error({
        action: "migration.payroll.fail",
        payrollId,
        monolithCustomerId,
        error: errorMessage,
      });

      return {
        monolithPayrollId: payrollId,
        monolithCustomerId,
        billingCustomerId,
        status: "failed" as const,
        reason: errorMessage,
      };
    }
  }

  // --- Line item decomposition (AC6) ---

  private buildPayrollLineItems(
    payroll: MonolithCustomerPayroll,
    totalCents: number,
    invoiceId: string,
  ): {
    items: Array<{
      id: string;
      invoiceId: string;
      type: string;
      description: string;
      amountCents: number;
      quantity: number;
      createdAt: Date;
    }>;
    warnings: number;
  } {
    const items: Array<{
      id: string;
      invoiceId: string;
      type: string;
      description: string;
      amountCents: number;
      quantity: number;
      createdAt: Date;
    }> = [];
    const now = new Date();
    let warnings = 0;

    const bonusCents = dollarsToCents(payroll.Total_Bonus) ?? 0;
    const surchargeCents = dollarsToCents(payroll.Credit_Card_Surcharge) ?? 0;

    // Base amount = Total - Bonus - Surcharge
    const baseCents = totalCents - bonusCents - surchargeCents;

    // Payroll month for description
    const monthDesc = payroll.Payroll_Month
      ? new Date(payroll.Payroll_Month).toISOString().slice(0, 7)
      : "unknown";

    // Base fee line item
    items.push({
      id: generateId(),
      invoiceId,
      type: "base_fee",
      description: `Payroll billing for ${monthDesc}`,
      amountCents: baseCents,
      quantity: 1,
      createdAt: now,
    });

    // Bonus line item (if non-null, non-zero)
    if (bonusCents !== 0) {
      items.push({
        id: generateId(),
        invoiceId,
        type: "base_fee",
        description: "Bonus component",
        amountCents: bonusCents,
        quantity: 1,
        createdAt: now,
      });
    }

    // Surcharge line item (if non-null, non-zero)
    if (surchargeCents !== 0) {
      items.push({
        id: generateId(),
        invoiceId,
        type: "surcharge",
        description: "Credit card surcharge",
        amountCents: surchargeCents,
        quantity: 1,
        createdAt: now,
      });
    }

    // Validate line items sum matches total
    const lineItemSum = items.reduce((sum, item) => sum + item.amountCents, 0);
    if (Math.abs(lineItemSum - totalCents) > 1) {
      this.logger.warn({
        action: "migration.payroll.line_item_total_mismatch",
        payrollId: payroll.Customer_Payroll_ID,
        expected: totalCents,
        actual: lineItemSum,
        field: "line_item_total_mismatch",
      });
      warnings++;
    }

    return { items, warnings };
  }

  // --- Payment method lookup (AC8) ---

  private findPaymentMethod(
    payroll: MonolithCustomerPayroll,
    customerPMs: Array<{
      id: string;
      type: string;
      isDefault: boolean;
    }>,
    billingCustomerId: string,
    monolithCustomerId: string,
  ): string | null {
    if (customerPMs.length === 0) return null;

    const expectedType = mapPaymentMethodType(payroll.Payment_Method);

    if (expectedType) {
      // Try to find matching type with isDefault = true
      const defaultMatch = customerPMs.find(
        (pm) => pm.type === expectedType && pm.isDefault,
      );
      if (defaultMatch) return defaultMatch.id;

      // Fall back to any matching type
      const typeMatch = customerPMs.find((pm) => pm.type === expectedType);
      if (typeMatch) {
        this.logger.warn({
          action: "migration.payroll.no_default_pm_for_type",
          billingCustomerId,
          monolithCustomerId,
          expectedType,
          usingPaymentMethodId: typeMatch.id,
        });
        return typeMatch.id;
      }
    }

    // Fall back to default PM of any type
    const defaultPm = customerPMs.find((pm) => pm.isDefault);
    if (defaultPm) {
      this.logger.warn({
        action: "migration.payroll.pm_type_mismatch_fallback",
        billingCustomerId,
        monolithCustomerId,
        expectedType,
        usingPaymentMethodId: defaultPm.id,
        usingType: defaultPm.type,
      });
      return defaultPm.id;
    }

    // Fall back to any active PM
    const anyPm = customerPMs[0];
    this.logger.warn({
      action: "migration.payroll.no_default_pm",
      billingCustomerId,
      monolithCustomerId,
      usingPaymentMethodId: anyPm.id,
    });
    return anyPm.id;
  }

  // --- Subscription alignment check (AC9) ---

  private async checkSubscriptionAlignment(
    billingCustomerId: string,
    monolithCustomerId: string,
    payrolls: MonolithCustomerPayroll[],
  ): Promise<void> {
    if (payrolls.length === 0) return;

    const latestPayroll = payrolls[payrolls.length - 1];
    const latestPayrollMonth = latestPayroll.Payroll_Month;

    const activeSubscriptions =
      await this.subscriptionsRepository.findByCustomerAndStatuses(
        billingCustomerId,
        ["active"],
      );
    const subscription = activeSubscriptions[0] ?? null;

    if (!subscription) {
      this.logger.log({
        action: "migration.payroll.no_subscription_alignment",
        billingCustomerId,
        monolithCustomerId,
        latestPayrollMonth,
      });
      return;
    }

    this.logger.log({
      action: "migration.payroll.subscription_alignment",
      billingCustomerId,
      monolithCustomerId,
      latestPayrollMonth,
      subscriptionId: subscription.id,
      nextBillingDate: subscription.nextBillingDate,
    });
  }

  // --- Batch processing ---

  private async processBatches(
    migratedCustomers: Array<{ id: string; monolithCustomerId: string }>,
    runId: string,
    scriptName: string,
    options: MigrationOptions,
  ): Promise<PayrollMigrationSummary> {
    const summary: PayrollMigrationSummary = {
      runId,
      scriptName,
      totalPayrolls: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      orphanedSkipped: 0,
      nullAmountSkipped: 0,
      ledgerPairsCreated: 0,
      conversionWarnings: 0,
      duration: 0,
    };

    const totalBatches = Math.ceil(
      migratedCustomers.length / options.batchSize,
    );

    for (let i = 0; i < migratedCustomers.length; i += options.batchSize) {
      const batch = migratedCustomers.slice(i, i + options.batchSize);
      const batchNumber = Math.floor(i / options.batchSize) + 1;

      for (const customer of batch) {
        const results = await this.migratePayrollForCustomer(
          customer.id,
          customer.monolithCustomerId,
          runId,
          scriptName,
          options,
        );

        for (const result of results) {
          summary.totalPayrolls++;
          if (result.status === "succeeded") {
            summary.succeeded++;
            summary.ledgerPairsCreated += result.ledgerPairCount ?? 0;
            summary.conversionWarnings += result.conversionWarnings ?? 0;
          } else if (result.status === "skipped") {
            if (result.reason === "orphaned_no_customer_id") {
              summary.orphanedSkipped++;
            } else if (result.reason === "null_amount") {
              summary.nullAmountSkipped++;
            } else {
              summary.skipped++;
            }
          } else {
            summary.failed++;
          }
        }
      }

      this.logger.log({
        action: "migration.payroll.batch_progress",
        batchNumber,
        totalBatches,
        totalPayrolls: summary.totalPayrolls,
      });

      // Batch delay (skip after last batch)
      if (i + options.batchSize < migratedCustomers.length) {
        await this.sleep(options.batchDelayMs);
      }
    }

    return summary;
  }

  // --- Utility methods ---

  private getLedgerPairCount(statusMapping: {
    invoiceStatus: string;
    createCharge: boolean;
  }): number {
    switch (statusMapping.invoiceStatus) {
      case "paid":
        return 2; // finalize + payment
      case "finalized":
        return 1; // finalize only
      default:
        return 0;
    }
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

  private summaryToLog(
    summary: PayrollMigrationSummary,
  ): Record<string, unknown> {
    return {
      totalPayrolls: summary.totalPayrolls,
      succeeded: summary.succeeded,
      skipped: summary.skipped,
      failed: summary.failed,
      orphanedSkipped: summary.orphanedSkipped,
      nullAmountSkipped: summary.nullAmountSkipped,
      ledgerPairsCreated: summary.ledgerPairsCreated,
      duration: summary.duration,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
