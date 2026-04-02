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
import { InvoicesRepository } from "../invoices/invoices.repository";
import { LedgerService } from "../ledger/ledger.service";
import { MigrationLogsRepository } from "./migration-logs.repository";
import { MONOLITH_DB_PROVIDER } from "./monolith-database.provider";
import type { MigrationOptions } from "./dto/migration-options.dto";

// --- Monolith data interfaces (Task 2) ---

export interface MonolithCustomerCharge {
  Charge_ID: number;
  Customer_ID: string;
  Amount: string | null; // numeric(10,2) comes as string from pg
  Charge_Type: string | null;
  Payment_Status: string | null;
  Payment_Date: Date | null;
  Failure_Reason: string | null;
  Scheduled_At: Date | null;
  Credit_Card_Surcharge: string | null; // numeric
  Starting_Balance: string | null; // numeric
  Invoice_ID: string | null;
  deletedAt: Date | null;
  createdAt: Date | null;
}

export interface MonolithOneTimeChargeLineItem {
  id: number;
  Charge_ID: number;
  Fee: string | null; // numeric(10,2) as string
  Implementation_Fee: string | null;
  Discount: string | null;
  Total: string | null;
  Employee_Name: string | null;
  Notes: string | null;
  Type: string | null;
}

// --- Migration result types ---

export interface ChargeMigrationResult {
  monolithChargeId: number;
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

export interface ChargeMigrationSummary {
  runId: string;
  scriptName: string;
  totalCharges: number;
  succeeded: number;
  skipped: number;
  failed: number;
  softDeletedSkipped: number;
  totalLedgerPairsCreated: number;
  totalLineItems: number;
  conversionWarnings: number;
  duration: number;
}

// --- Helper functions ---

export function dollarsToCents(
  dollars: number | string | null | undefined,
): number | null {
  if (dollars === null || dollars === undefined) return null;
  const num = typeof dollars === "string" ? parseFloat(dollars) : dollars;
  if (isNaN(num)) return null;
  return Math.round(num * 100);
}

export function mapPaymentStatus(monolithStatus: string | null): {
  invoiceStatus: string;
  createCharge: boolean;
  chargeStatus?: string;
} | null {
  const normalized = monolithStatus?.toLowerCase().trim();
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
    case "voided":
    case "refunded":
      return { invoiceStatus: "void", createCharge: false };
    default:
      return null; // Unknown — skip with warning
  }
}

@Injectable()
export class ChargesMigrationService {
  private readonly logger = new Logger(ChargesMigrationService.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    @Optional()
    @Inject(MONOLITH_DB_PROVIDER)
    private readonly monolithPool: Pool | null,
    private readonly customersRepository: CustomersRepository,
    private readonly paymentMethodsRepository: PaymentMethodsRepository,
    private readonly invoicesRepository: InvoicesRepository,
    private readonly ledgerService: LedgerService,
    private readonly migrationLogsRepository: MigrationLogsRepository,
  ) {}

  // --- Monolith query helpers (Task 2.3, 2.4) ---

  async fetchChargesForCustomer(
    monolithCustomerId: string,
  ): Promise<MonolithCustomerCharge[]> {
    if (!this.monolithPool) {
      throw new Error(
        "Monolith database connection is not configured. Set MONOLITH_DATABASE_* environment variables.",
      );
    }

    const result = await this.monolithPool.query<MonolithCustomerCharge>(
      `SELECT "Charge_ID", "Customer_ID", "Amount", "Charge_Type",
              "Payment_Status", "Payment_Date", "Failure_Reason",
              "Scheduled_At", "Credit_Card_Surcharge", "Starting_Balance",
              "Invoice_ID", "deletedAt", "createdAt"
       FROM "Customer_Charge"
       WHERE "Customer_ID" = $1
       ORDER BY "Charge_ID" ASC`,
      [monolithCustomerId],
    );

    return result.rows;
  }

  async fetchLineItemsForCharge(
    chargeId: number,
  ): Promise<MonolithOneTimeChargeLineItem[]> {
    if (!this.monolithPool) {
      throw new Error(
        "Monolith database connection is not configured. Set MONOLITH_DATABASE_* environment variables.",
      );
    }

    const result = await this.monolithPool.query<MonolithOneTimeChargeLineItem>(
      `SELECT "id", "Charge_ID", "Fee", "Implementation_Fee", "Discount",
                "Total", "Employee_Name", "Notes", "Type"
         FROM "One_Time_Charge_Invoice_Items"
         WHERE "Charge_ID" = $1`,
      [chargeId],
    );

    return result.rows;
  }

  // --- Main migration methods (Task 3.2, 3.3) ---

  async migrateAll(options: MigrationOptions): Promise<ChargeMigrationSummary> {
    if (!this.monolithPool) {
      throw new Error(
        "Monolith database connection is not configured. Set MONOLITH_DATABASE_* environment variables.",
      );
    }

    const runId = generateId();
    const startTime = Date.now();
    const scriptName = options.dryRun
      ? "migrate-customer-charges-dry-run"
      : "migrate-customer-charges";

    this.logger.log({
      action: "migration.charges.start",
      runId,
      dryRun: options.dryRun,
      batchSize: options.batchSize,
    });

    // Get all migrated customers (have monolith_customer_id in billing DB)
    const migratedCustomers =
      await this.customersRepository.findAllForMigration();

    const summary = await this.processBatches(
      migratedCustomers,
      runId,
      scriptName,
      options,
    );

    summary.duration = Date.now() - startTime;

    this.logger.log({
      action: "migration.charges.complete",
      ...this.summaryToLog(summary),
    });

    return summary;
  }

  async migrateByIds(
    monolithCustomerIds: string[],
    options: MigrationOptions,
  ): Promise<ChargeMigrationSummary> {
    if (!this.monolithPool) {
      throw new Error(
        "Monolith database connection is not configured. Set MONOLITH_DATABASE_* environment variables.",
      );
    }

    const runId = generateId();
    const startTime = Date.now();
    const scriptName = options.dryRun
      ? "migrate-customer-charges-dry-run"
      : "migrate-customer-charges";

    this.logger.log({
      action: "migration.charges.start_by_ids",
      runId,
      dryRun: options.dryRun,
      customerCount: monolithCustomerIds.length,
    });

    // Look up billing customers by their monolith IDs
    const migratedCustomers: { id: string; monolithCustomerId: string }[] = [];
    for (const monolithId of monolithCustomerIds) {
      const customer =
        await this.customersRepository.findByMonolithId(monolithId);

      if (customer) {
        migratedCustomers.push(customer);
      } else {
        this.logger.warn({
          action: "migration.charges.customer_not_found",
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
      action: "migration.charges.complete",
      ...this.summaryToLog(summary),
    });

    return summary;
  }

  // --- Per-customer migration (Task 3.4) ---

  async migrateChargesForCustomer(
    billingCustomerId: string,
    monolithCustomerId: string,
    runId: string,
    scriptName: string,
    options: MigrationOptions,
  ): Promise<ChargeMigrationResult[]> {
    const results: ChargeMigrationResult[] = [];

    const monolithCharges =
      await this.fetchChargesForCustomer(monolithCustomerId);

    // Look up customer's default payment method, fallback to any active PM
    const defaultPm =
      await this.paymentMethodsRepository.getDefaultPaymentMethod(
        billingCustomerId,
      );

    let paymentMethodId = defaultPm?.id ?? null;

    if (!paymentMethodId) {
      const allPms =
        await this.paymentMethodsRepository.findAllByCustomerUnfiltered(
          billingCustomerId,
        );
      const anyPm = allPms[0] ?? null;

      if (anyPm) {
        this.logger.warn({
          action: "migration.charges.no_default_pm",
          billingCustomerId,
          monolithCustomerId,
          usingPaymentMethodId: anyPm.id,
        });
        paymentMethodId = anyPm.id;
      }
    }

    for (const charge of monolithCharges) {
      const lineItems = await this.fetchLineItemsForCharge(charge.Charge_ID);

      const result = await this.migrateSingleCharge(
        charge,
        lineItems,
        billingCustomerId,
        monolithCustomerId,
        paymentMethodId,
        runId,
        scriptName,
        options,
      );

      results.push(result);
    }

    return results;
  }

  // --- Per-charge migration (Task 3.5) ---

  async migrateSingleCharge(
    charge: MonolithCustomerCharge,
    lineItems: MonolithOneTimeChargeLineItem[],
    billingCustomerId: string,
    monolithCustomerId: string,
    paymentMethodId: string | null,
    runId: string,
    scriptName: string,
    options: MigrationOptions,
  ): Promise<ChargeMigrationResult> {
    const chargeId = charge.Charge_ID;

    try {
      // AC3: Soft-deleted records → skip entirely
      if (charge.deletedAt) {
        const result: ChargeMigrationResult = {
          monolithChargeId: chargeId,
          monolithCustomerId,
          billingCustomerId,
          status: "skipped",
          reason: "soft_deleted",
        };

        this.logger.log({
          action: "migration.charges.soft_deleted_skip",
          chargeId,
        });

        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          billingCustomerId,
          "skipped",
          null,
          { chargeId, reason: "soft_deleted" },
        );

        return result;
      }

      // AC2: Null amount → skip
      const totalCents = dollarsToCents(charge.Amount);
      if (totalCents === null) {
        const result: ChargeMigrationResult = {
          monolithChargeId: chargeId,
          monolithCustomerId,
          billingCustomerId,
          status: "skipped",
          reason: "null_amount",
        };

        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          billingCustomerId,
          "skipped",
          null,
          { chargeId, reason: "null_amount" },
        );

        return result;
      }

      // AC4: Payment status mapping
      const statusMapping = mapPaymentStatus(charge.Payment_Status);
      if (!statusMapping) {
        const result: ChargeMigrationResult = {
          monolithChargeId: chargeId,
          monolithCustomerId,
          billingCustomerId,
          status: "skipped",
          reason: "unknown_payment_status",
        };

        this.logger.warn({
          action: "migration.charges.unknown_status",
          chargeId,
          originalStatus: charge.Payment_Status,
        });

        await this.writeMigrationLog(
          runId,
          scriptName,
          monolithCustomerId,
          billingCustomerId,
          "skipped",
          null,
          {
            chargeId,
            reason: "unknown_payment_status",
            originalStatus: charge.Payment_Status,
          },
        );

        return result;
      }

      // AC8: Idempotency check by metadata
      const existing = await this.invoicesRepository.findByMonolithMetadata(
        "monolith_charge_id",
        String(chargeId),
      );

      if (existing) {
        const result: ChargeMigrationResult = {
          monolithChargeId: chargeId,
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
          { chargeId, reason: "already_migrated" },
        );

        return result;
      }

      // AC: charges.paymentMethodId is NOT NULL — check PM exists for charge-creating statuses
      if (statusMapping.createCharge && !paymentMethodId) {
        const result: ChargeMigrationResult = {
          monolithChargeId: chargeId,
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
          { chargeId, reason: "no_payment_method" },
        );

        return result;
      }

      // AC2: Dollar-to-cents conversion logging
      this.logger.log({
        action: "migration.charges.conversion",
        chargeId,
        originalDollars: charge.Amount,
        convertedCents: totalCents,
        field: "Amount",
      });

      // Build line items and compute invoice total (shared by dry-run and real path)
      const invoiceId = generateId();
      const billingDate =
        charge.Scheduled_At ??
        charge.Payment_Date ??
        charge.createdAt ??
        new Date();
      const { items: builtLineItems, warnings: lineItemWarnings } =
        this.buildLineItems(charge, lineItems, totalCents, invoiceId);
      const invoiceTotalCents = builtLineItems.reduce(
        (sum, item) => sum + item.amountCents,
        0,
      );

      // AC9: Dry-run mode — validate and log without writes
      if (options.dryRun) {
        const result: ChargeMigrationResult = {
          monolithChargeId: chargeId,
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
            chargeId,
            reason: "dry_run",
            invoiceStatus: statusMapping.invoiceStatus,
            lineItemCount: builtLineItems.length,
            totalCents: invoiceTotalCents,
          },
        );

        return result;
      }

      // --- Real migration within a transaction ---
      const absTotalCents = Math.abs(invoiceTotalCents);
      let createdChargeId: string | undefined;
      let ledgerPairCount = 0;

      await this.db.transaction(async (tx) => {
        // 1. Insert invoice
        await tx.insert(invoices).values({
          id: invoiceId,
          customerId: billingCustomerId,
          subscriptionId: null,
          status: statusMapping.invoiceStatus,
          totalAmountCents: absTotalCents,
          currency: "usd",
          billingPeriodStart: billingDate,
          billingPeriodEnd: billingDate,
          dueDate: billingDate,
          paidAt:
            statusMapping.invoiceStatus === "paid"
              ? (charge.Payment_Date ?? billingDate)
              : null,
          voidedAt: statusMapping.invoiceStatus === "void" ? billingDate : null,
          metadata: {
            monolith_charge_id: chargeId,
            ...(charge.Invoice_ID
              ? { stripe_invoice_id: charge.Invoice_ID }
              : {}),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // 2. Insert pre-built invoice line items
        for (const item of builtLineItems) {
          await tx.insert(invoiceLineItems).values(item);
        }

        // 3. Insert charge record (if paid/failed/pending — not for voided)
        if (statusMapping.createCharge && paymentMethodId) {
          createdChargeId = generateId();
          await tx.insert(charges).values({
            id: createdChargeId,
            invoiceId,
            customerId: billingCustomerId,
            paymentMethodId,
            amountCents: absTotalCents,
            currency: "usd",
            status: statusMapping.chargeStatus!,
            stripePaymentIntentId: null,
            idempotencyKey: `mig_charge_${chargeId}`,
            failureReason: charge.Failure_Reason ?? null,
            attemptNumber: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }

        // 4. Insert ledger entries via LedgerService with tx parameter
        const correlationId = `migration-${runId}`;

        if (
          statusMapping.invoiceStatus === "paid" ||
          statusMapping.invoiceStatus === "finalized"
        ) {
          await this.ledgerService.recordMigrationInvoiceFinalized(
            invoiceId,
            absTotalCents,
            "usd",
            chargeId,
            correlationId,
            tx,
          );
          ledgerPairCount++;
        }

        if (statusMapping.invoiceStatus === "paid") {
          await this.ledgerService.recordMigrationPayment(
            invoiceId,
            absTotalCents,
            "usd",
            chargeId,
            correlationId,
            tx,
          );
          ledgerPairCount++;
        }

        if (statusMapping.invoiceStatus === "void") {
          await this.ledgerService.recordMigrationInvoiceFinalized(
            invoiceId,
            absTotalCents,
            "usd",
            chargeId,
            correlationId,
            tx,
          );
          ledgerPairCount++;

          await this.ledgerService.recordMigrationVoidReversal(
            invoiceId,
            absTotalCents,
            "usd",
            chargeId,
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
            chargeId,
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
        monolithChargeId: chargeId,
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
          { chargeId, action: "migration.charges" },
        );
      } catch (logError) {
        this.logger.error({
          action: "migration.charges.log_write_failed",
          chargeId,
          logError:
            logError instanceof Error ? logError.message : String(logError),
        });
      }

      this.logger.error({
        action: "migration.charges.fail",
        chargeId,
        monolithCustomerId,
        error: errorMessage,
      });

      return {
        monolithChargeId: chargeId,
        monolithCustomerId,
        billingCustomerId,
        status: "failed" as const,
        reason: errorMessage,
      };
    }
  }

  // --- Line item decomposition (Task 3.8, 3.9) ---

  private buildLineItems(
    charge: MonolithCustomerCharge,
    lineItems: MonolithOneTimeChargeLineItem[],
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

    if (lineItems.length > 0) {
      // AC5: Decompose from One_Time_Charge_Invoice_Items
      for (const item of lineItems) {
        const feeCents = dollarsToCents(item.Fee);
        if (feeCents !== null && feeCents !== 0) {
          const desc = [item.Employee_Name, item.Notes]
            .filter(Boolean)
            .join(" - ");
          items.push({
            id: generateId(),
            invoiceId,
            type: "base_fee",
            description: desc ? `Fee: ${desc}` : "Fee",
            amountCents: feeCents,
            quantity: 1,
            createdAt: now,
          });
        }

        const implFeeCents = dollarsToCents(item.Implementation_Fee);
        if (implFeeCents !== null && implFeeCents !== 0) {
          items.push({
            id: generateId(),
            invoiceId,
            type: "implementation_fee",
            description: item.Employee_Name
              ? `Implementation fee: ${item.Employee_Name}`
              : "Implementation fee",
            amountCents: implFeeCents,
            quantity: 1,
            createdAt: now,
          });
        }

        const discountCents = dollarsToCents(item.Discount);
        if (discountCents !== null && discountCents !== 0) {
          items.push({
            id: generateId(),
            invoiceId,
            type: "discount",
            description: item.Employee_Name
              ? `Discount: ${item.Employee_Name}`
              : "Discount",
            amountCents: -Math.abs(discountCents),
            quantity: 1,
            createdAt: now,
          });
        }

        // AC2/AC5: Validate line item total; log Type as context
        const expectedTotal = dollarsToCents(item.Total);
        if (expectedTotal !== null && feeCents !== null) {
          const computedTotal =
            (feeCents ?? 0) +
            (implFeeCents ?? 0) -
            Math.abs(discountCents ?? 0);
          if (Math.abs(computedTotal - expectedTotal) > 1) {
            this.logger.warn({
              action: "migration.charges.line_item_total_mismatch",
              chargeId: charge.Charge_ID,
              expected: expectedTotal,
              actual: computedTotal,
              field: "line_item_total_mismatch",
              lineItemType: item.Type,
            });
            warnings++;
          }
        }
      }
    } else {
      // AC6: Charges without line items — single base_fee
      items.push({
        id: generateId(),
        invoiceId,
        type: "base_fee",
        description: "Historical charge from monolith",
        amountCents: Math.abs(totalCents),
        quantity: 1,
        createdAt: now,
      });
    }

    // AC1/AC5: Credit card surcharge as separate line item
    const surchargeCents = dollarsToCents(charge.Credit_Card_Surcharge);
    if (surchargeCents !== null && surchargeCents !== 0) {
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

    return { items, warnings };
  }

  // --- Batch processing (Task 3.13) ---

  private async processBatches(
    migratedCustomers: Array<{ id: string; monolithCustomerId: string }>,
    runId: string,
    scriptName: string,
    options: MigrationOptions,
  ): Promise<ChargeMigrationSummary> {
    const summary: ChargeMigrationSummary = {
      runId,
      scriptName,
      totalCharges: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      softDeletedSkipped: 0,
      totalLedgerPairsCreated: 0,
      totalLineItems: 0,
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
        const results = await this.migrateChargesForCustomer(
          customer.id,
          customer.monolithCustomerId,
          runId,
          scriptName,
          options,
        );

        for (const result of results) {
          summary.totalCharges++;
          summary.conversionWarnings += result.conversionWarnings ?? 0;
          if (result.status === "succeeded") {
            summary.succeeded++;
            summary.totalLedgerPairsCreated += result.ledgerPairCount ?? 0;
            summary.totalLineItems += result.lineItemCount ?? 0;
          } else if (result.status === "skipped") {
            if (result.reason === "soft_deleted") {
              summary.softDeletedSkipped++;
            } else {
              summary.skipped++;
            }
          } else {
            summary.failed++;
          }
        }
      }

      this.logger.log({
        action: "migration.charges.batch_progress",
        batchNumber,
        totalBatches,
        totalCharges: summary.totalCharges,
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
      case "void":
        return 2; // finalize + reversal
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
    summary: ChargeMigrationSummary,
  ): Record<string, unknown> {
    return {
      totalCharges: summary.totalCharges,
      succeeded: summary.succeeded,
      skipped: summary.skipped,
      failed: summary.failed,
      totalLedgerPairsCreated: summary.totalLedgerPairsCreated,
      totalLineItems: summary.totalLineItems,
      duration: summary.duration,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
