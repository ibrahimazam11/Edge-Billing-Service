import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Pool } from "pg";
import { CustomersRepository } from "../customers/customers.repository";
import { InvoicesRepository } from "../invoices/invoices.repository";
import { MONOLITH_DB_PROVIDER } from "./monolith-database.provider";
import {
  ReconciliationService,
  type ReconciliationRun,
} from "../reconciliation/reconciliation.service";
import type {
  CustomerValidationResult,
  ValidationDiscrepancy,
} from "./dto/customer-validation-result.dto";
import type { WaveValidationResult } from "./dto/wave-validation-result.dto";

interface MonolithChargeStats {
  count: number;
  paidCount: number;
  totalDollars: number;
}

interface BillingInvoiceStats {
  count: number;
  paidCount: number;
  totalCents: number;
}

@Injectable()
export class MigrationValidationService {
  private readonly logger = new Logger(MigrationValidationService.name);

  constructor(
    private readonly customersRepository: CustomersRepository,
    private readonly invoicesRepository: InvoicesRepository,
    @Optional()
    @Inject(MONOLITH_DB_PROVIDER)
    private readonly monolithPool: Pool | null,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  async validateCustomer(
    customerId: string,
  ): Promise<CustomerValidationResult> {
    if (!this.monolithPool) {
      return {
        customerId,
        status: "error",
        error: "monolith_db_unavailable",
        recordsCompared: 0,
        discrepancies: [],
      };
    }

    try {
      // 1. Look up billing customer to get monolith_customer_id
      const customer = await this.customersRepository.findById(customerId);

      if (!customer) {
        return {
          customerId,
          status: "error",
          error: "customer_not_found_in_billing",
          recordsCompared: 0,
          discrepancies: [],
        };
      }

      // 2. Query monolith for charge stats
      const monolithChargeStats = await this.getMonolithChargeStats(
        customer.monolithCustomerId,
      );

      // 3. Query monolith for payroll stats
      const monolithPayrollStats = await this.getMonolithPayrollStats(
        customer.monolithCustomerId,
      );

      // 4. Query billing DB for invoice stats
      const billingChargeInvoices = await this.getBillingInvoiceStats(
        customerId,
        "monolith_charge_id",
      );

      const billingPayrollInvoices = await this.getBillingInvoiceStats(
        customerId,
        "monolith_payroll_id",
      );

      // 5. Compare
      const discrepancies: ValidationDiscrepancy[] = [];
      const totalMonolithRecords =
        monolithChargeStats.count + monolithPayrollStats.count;
      const totalBillingRecords =
        billingChargeInvoices.count + billingPayrollInvoices.count;

      // Count comparison
      if (monolithChargeStats.count !== billingChargeInvoices.count) {
        discrepancies.push({
          field: "charge_count",
          billingServiceValue: billingChargeInvoices.count,
          monolithValue: monolithChargeStats.count,
          recordReference: `customer ${customer.monolithCustomerId}`,
        });
      }

      if (monolithPayrollStats.count !== billingPayrollInvoices.count) {
        discrepancies.push({
          field: "payroll_count",
          billingServiceValue: billingPayrollInvoices.count,
          monolithValue: monolithPayrollStats.count,
          recordReference: `customer ${customer.monolithCustomerId}`,
        });
      }

      // Amount comparison (cents to dollars, 1 cent tolerance)
      const monolithChargeCents = Math.round(
        monolithChargeStats.totalDollars * 100,
      );
      if (
        Math.abs(monolithChargeCents - billingChargeInvoices.totalCents) > 1
      ) {
        discrepancies.push({
          field: "charge_total_amount",
          billingServiceValue: billingChargeInvoices.totalCents,
          monolithValue: monolithChargeCents,
          recordReference: `customer ${customer.monolithCustomerId} (billing cents vs monolith dollars*100)`,
        });
      }

      const monolithPayrollCents = Math.round(
        monolithPayrollStats.totalDollars * 100,
      );
      if (
        Math.abs(monolithPayrollCents - billingPayrollInvoices.totalCents) > 1
      ) {
        discrepancies.push({
          field: "payroll_total_amount",
          billingServiceValue: billingPayrollInvoices.totalCents,
          monolithValue: monolithPayrollCents,
          recordReference: `customer ${customer.monolithCustomerId} (billing cents vs monolith dollars*100)`,
        });
      }

      // Paid count comparison
      const totalMonolithPaid =
        monolithChargeStats.paidCount + monolithPayrollStats.paidCount;
      const totalBillingPaid =
        billingChargeInvoices.paidCount + billingPayrollInvoices.paidCount;

      if (totalMonolithPaid !== totalBillingPaid) {
        discrepancies.push({
          field: "paid_count",
          billingServiceValue: totalBillingPaid,
          monolithValue: totalMonolithPaid,
          recordReference: `customer ${customer.monolithCustomerId}`,
        });
      }

      const recordsCompared = Math.max(
        totalMonolithRecords,
        totalBillingRecords,
      );
      const status =
        discrepancies.length === 0 ? "consistent" : "discrepancy_found";

      this.logger.log({
        customerId,
        monolithCustomerId: customer.monolithCustomerId,
        recordsCompared,
        discrepancies: discrepancies.length,
        status,
        action: "validation.customer_completed",
      });

      return {
        customerId,
        status,
        recordsCompared,
        discrepancies,
      };
    } catch (error) {
      this.logger.error({
        customerId,
        error: error instanceof Error ? error.message : String(error),
        action: "validation.customer_failed",
      });

      return {
        customerId,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        recordsCompared: 0,
        discrepancies: [],
      };
    }
  }

  async validateWave(customerIds: string[]): Promise<WaveValidationResult> {
    const results: CustomerValidationResult[] = [];

    for (const customerId of customerIds) {
      results.push(await this.validateCustomer(customerId));
    }

    const summary: WaveValidationResult = {
      waveSize: customerIds.length,
      consistent: results.filter((r) => r.status === "consistent").length,
      discrepancyFound: results.filter((r) => r.status === "discrepancy_found")
        .length,
      errorCount: results.filter((r) => r.status === "error").length,
      totalRecordsCompared: results.reduce(
        (sum, r) => sum + r.recordsCompared,
        0,
      ),
      totalDiscrepancies: results.reduce(
        (sum, r) => sum + r.discrepancies.length,
        0,
      ),
      customerResults: results,
    };

    this.logger.log({
      waveSize: summary.waveSize,
      consistent: summary.consistent,
      discrepancyFound: summary.discrepancyFound,
      errorCount: summary.errorCount,
      totalRecordsCompared: summary.totalRecordsCompared,
      totalDiscrepancies: summary.totalDiscrepancies,
      action: "validation.wave_completed",
    });

    return summary;
  }

  async runMigrationReconciliation(
    periodStart: Date,
    periodEnd: Date,
    correlationId: string,
  ): Promise<ReconciliationRun> {
    this.logger.log({
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      correlationId,
      action: "validation.reconciliation_started",
    });

    return this.reconciliationService.runDailyReconciliation(
      periodStart,
      periodEnd,
      correlationId,
    );
  }

  private async getMonolithChargeStats(
    monolithCustomerId: string,
  ): Promise<MonolithChargeStats> {
    const result = await this.monolithPool!.query(
      `SELECT
        COUNT(*)::int as count,
        COALESCE(SUM(CASE WHEN "Payment_Status" IN ('paid','succeeded') THEN 1 ELSE 0 END), 0)::int as paid_count,
        COALESCE(SUM("Amount"), 0)::float as total_dollars
      FROM "Customer_Charge"
      WHERE "Customer_ID" = $1 AND "deletedAt" IS NULL`,
      [monolithCustomerId],
    );

    const row = result.rows[0] as {
      count: number;
      paid_count: number;
      total_dollars: number;
    };

    return {
      count: row.count,
      paidCount: row.paid_count,
      totalDollars: row.total_dollars,
    };
  }

  private async getMonolithPayrollStats(
    monolithCustomerId: string,
  ): Promise<MonolithChargeStats> {
    const result = await this.monolithPool!.query(
      `SELECT
        COUNT(*)::int as count,
        COALESCE(SUM(CASE WHEN "Status" IN ('paid','succeeded') THEN 1 ELSE 0 END), 0)::int as paid_count,
        COALESCE(SUM("Total_Amount"), 0)::float as total_dollars
      FROM "Customer_Payroll"
      WHERE "Customer_ID" = $1 AND "Total_Amount" IS NOT NULL`,
      [monolithCustomerId],
    );

    const row = result.rows[0] as {
      count: number;
      paid_count: number;
      total_dollars: number;
    };

    return {
      count: row.count,
      paidCount: row.paid_count,
      totalDollars: row.total_dollars,
    };
  }

  private async getBillingInvoiceStats(
    customerId: string,
    metadataKey: string,
  ): Promise<BillingInvoiceStats> {
    const stats = await this.invoicesRepository.getBillingStatsForMigration(
      customerId,
      metadataKey,
    );

    return {
      count: Number(stats.count),
      paidCount: Number(stats.paidCount),
      totalCents: Number(stats.totalCents),
    };
  }
}
