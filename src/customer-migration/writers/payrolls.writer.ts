import { Inject, Injectable, Logger } from "@nestjs/common";
import { DRIZZLE_PROVIDER } from "../../database/database.provider";
import type { DrizzleDatabase } from "../../database/types";
import { invoices } from "../../database/schema/invoices";
import { invoiceLineItems } from "../../database/schema/invoice-line-items";
import { charges as chargesTable } from "../../database/schema/charges";
import { generateId } from "../../common/utils/uuid.util";
import { LedgerService } from "../../ledger/ledger.service";
import { InvoicesRepository } from "../../invoices/invoices.repository";
import { PaymentMethodsRepository } from "../../payment-methods/payment-methods.repository";
import { toCents, toCentsOrNull, type StepResult } from "../helpers";
import type { PayrollInputDto } from "../dto/migrate-customer-body.dto";

export interface PayrollsWriteInput {
  billingCustomerId: string;
  payrolls: PayrollInputDto[];
}

interface StatusMap {
  invoiceStatus: "draft" | "paid" | "finalized" | "void";
  createCharge: boolean;
  chargeStatus?: "succeeded" | "failed" | "pending";
  ledgerPairCount: number;
}

function mapPayrollStatus(p: PayrollInputDto, now: Date): StatusMap | null {
  if (p.deletedAt) {
    return { invoiceStatus: "void", createCharge: false, ledgerPairCount: 2 };
  }
  if (p.failure === true) {
    return {
      invoiceStatus: "finalized",
      createCharge: true,
      chargeStatus: "failed",
      ledgerPairCount: 1,
    };
  }
  const s = (p.status ?? "").toLowerCase().trim();
  switch (s) {
    case "paid":
    case "succeeded":
      return {
        invoiceStatus: "paid",
        createCharge: true,
        chargeStatus: "succeeded",
        ledgerPairCount: 2,
      };
    case "failed":
      return {
        invoiceStatus: "finalized",
        createCharge: true,
        chargeStatus: "failed",
        ledgerPairCount: 1,
      };
    case "pending":
    case "processing":
      return {
        invoiceStatus: "finalized",
        createCharge: true,
        chargeStatus: "pending",
        ledgerPairCount: 1,
      };
    case "un-paid":
    case "unpaid": {
      // spec-billing-migration-future-unpaid-as-draft.md:
      // The latest un-paid placeholder represents the upcoming cycle that BS
      // must own and bill on chargeDay. Migrate it as `draft` so the BS
      // scheduler picks it up to finalize + charge when due. Historical un-paid
      // placeholders (Payroll_Month already past) remain `finalized` — they
      // never had a Stripe charge and shouldn't be re-charged.
      const payrollMonthIsFuture =
        new Date(p.payrollMonth).getTime() > now.getTime();
      if (payrollMonthIsFuture) {
        return {
          invoiceStatus: "draft",
          createCharge: false,
          ledgerPairCount: 0,
        };
      }
      return {
        invoiceStatus: "finalized",
        createCharge: false,
        ledgerPairCount: 1,
      };
    }
    default:
      return null;
  }
}

function deriveBillingPeriod(month: string): {
  start: Date;
  end: Date;
} {
  const d = new Date(month);
  return {
    start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
    end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)),
  };
}

@Injectable()
export class PayrollsWriter {
  private readonly logger = new Logger(PayrollsWriter.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    private readonly invoicesRepository: InvoicesRepository,
    private readonly paymentMethodsRepository: PaymentMethodsRepository,
    private readonly ledgerService: LedgerService,
  ) {}

  async write(
    input: PayrollsWriteInput,
    opts: { dryRun: boolean; runId: string },
  ): Promise<StepResult & { details?: unknown[] }> {
    if (!input.payrolls || input.payrolls.length === 0) {
      return { status: "skipped", reason: "no_payrolls" };
    }

    const details: unknown[] = [];
    let succeededCount = 0;
    let skippedCount = 0;

    const pms = opts.dryRun
      ? []
      : await this.paymentMethodsRepository.findAllByCustomerUnfiltered(
          input.billingCustomerId,
        );
    const defaultPmId = pms.find((p) => p.isDefault)?.id ?? pms[0]?.id ?? null;

    // Single anchor for all per-row date decisions in this run. Keeps the
    // un-paid-future-vs-past gate consistent even if the run crosses midnight.
    // spec-billing-migration-future-unpaid-as-draft.md
    const runNow = new Date();

    for (const payroll of input.payrolls) {
      const statusMap = mapPayrollStatus(payroll, runNow);
      if (!statusMap) {
        details.push({
          customerPayrollId: payroll.customerPayrollId,
          status: "skipped",
          reason: "unknown_status",
        });
        skippedCount++;
        continue;
      }

      let totalCents: number;
      try {
        totalCents = toCents(payroll.totalAmount);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: "failed", reason: "invalid_total_amount", error: msg };
      }

      // Idempotency check. Bug 2 fix: run on both real-run AND dry-run so the
      // preview accurately reports already-migrated rows.
      {
        const existing = await this.invoicesRepository.findByMonolithMetadata(
          "monolith_payroll_id",
          payroll.customerPayrollId,
        );
        if (existing) {
          details.push({
            customerPayrollId: payroll.customerPayrollId,
            status: "skipped",
            reason: "already_migrated",
          });
          skippedCount++;
          continue;
        }
      }

      const { start: billingPeriodStart, end: billingPeriodEnd } =
        deriveBillingPeriod(payroll.payrollMonth);

      // Build line items: per-employee employee_cost lines + surcharge.
      const invoiceId = opts.dryRun ? "<dry-run-invoice>" : generateId();
      const now = new Date();
      const lineItemRows: Array<{
        id: string;
        invoiceId: string;
        type: string;
        description: string;
        amountCents: number;
        quantity: number;
        breakdown: Record<string, unknown> | null;
        createdAt: Date;
      }> = [];

      let employeeSumCents = 0;
      let invalidLineItem: string | null = null;

      for (const emp of payroll.employees) {
        // baseSalary (= monolith Customer_Cost) is the authoritative per-employee billed amount.
        // paidGrossSalary / bonus / platformFee are cost-breakdown components — informational for
        // rendering, not aggregate components of the billed amount.
        let baseCents: number;
        try {
          baseCents = toCents(emp.baseSalary);
        } catch (err) {
          invalidLineItem = err instanceof Error ? err.message : String(err);
          break;
        }
        let paidGrossSalaryCents: number | null = null;
        let bonusCents: number | null = null;
        let platformFeeCents: number | null = null;
        try {
          paidGrossSalaryCents = toCentsOrNull(emp.paidGrossSalary);
          bonusCents = toCentsOrNull(emp.bonus);
          platformFeeCents = toCentsOrNull(emp.platformFee);
        } catch (err) {
          invalidLineItem = err instanceof Error ? err.message : String(err);
          break;
        }

        const empTotal = baseCents;
        employeeSumCents += empTotal;

        // Emit the BS-native breakdown shape (subscriptions.service
        // buildEmployeeLineItems): { employeeId, salary, platformFee, bonus,
        // raise, discount } in cents. `salary` is the employee gross — monolith
        // paidGrossSalary — NOT the customer-billed total (baseSalary, which
        // already bundles fee+bonus). When paidGross is null (pre-platform-fee
        // historical rows) reconstruct it from baseSalary so the native invariant
        // `salary + platformFee + bonus === amountCents` still holds.
        const platformFee = platformFeeCents ?? 0;
        const bonus = bonusCents ?? 0;
        const salary = paidGrossSalaryCents ?? baseCents - platformFee - bonus;

        // Defensive guard: a migrated row must never reach the DB violating the
        // native invariant, or the stale-draft fallback (subscriptions.service)
        // would recompute a wrong amount when monolith payroll fetch fails.
        if (salary + platformFee + bonus !== empTotal) {
          this.logger.warn({
            action: "payrolls.writer.breakdown_invariant_violation",
            monolithPayrollId: payroll.customerPayrollId,
            employeeId: emp.employeeId ?? null,
            salary,
            platformFee,
            bonus,
            amountCents: empTotal,
          });
        }

        lineItemRows.push({
          id: opts.dryRun ? "<dry-run-li>" : generateId(),
          invoiceId,
          type: "employee_cost",
          description: emp.employeeName,
          amountCents: empTotal,
          quantity: 1,
          breakdown: {
            employeeId: emp.employeeId ?? null,
            salary,
            platformFee,
            bonus,
            raise: 0,
            discount: 0,
          },
          createdAt: now,
        });
      }

      if (invalidLineItem) {
        return {
          status: "failed",
          reason: "invalid_employee_amount",
          error: invalidLineItem,
        };
      }

      let surchargeCents = 0;
      try {
        surchargeCents = toCentsOrNull(payroll.creditCardSurcharge) ?? 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: "failed", reason: "invalid_surcharge", error: msg };
      }

      if (surchargeCents !== 0) {
        lineItemRows.push({
          id: opts.dryRun ? "<dry-run-li>" : generateId(),
          invoiceId,
          type: "surcharge",
          description: "Credit card surcharge",
          amountCents: surchargeCents,
          quantity: 1,
          breakdown: null,
          createdAt: now,
        });
      }

      const lineItemSum = lineItemRows.reduce((s, l) => s + l.amountCents, 0);
      // P10: always use monolith-authoritative totalCents as the invoice
      // total. When line items are present, cross-check the sum and warn on
      // mismatch beyond ±1¢ — do NOT silently substitute lineItemSum.
      if (lineItemRows.length > 0 && Math.abs(lineItemSum - totalCents) > 1) {
        this.logger.warn({
          action: "payrolls.writer.line_item_sum_mismatch",
          monolithPayrollId: payroll.customerPayrollId,
          lineItemSum,
          totalCents,
          delta: lineItemSum - totalCents,
        });
      }
      const finalTotalCents = totalCents;

      void employeeSumCents;

      const currency = payroll.localCurrency ?? "usd";
      const paymentDate = payroll.paymentDate
        ? new Date(payroll.paymentDate)
        : null;
      const paidOn = payroll.paidOn ? new Date(payroll.paidOn) : null;

      // P4: never fabricate paidAt. Use paidOn ?? paymentDate ?? null
      const paidAt =
        statusMap.invoiceStatus === "paid" ? (paidOn ?? paymentDate) : null;

      const voidedAt =
        statusMap.invoiceStatus === "void" && payroll.deletedAt
          ? new Date(payroll.deletedAt)
          : null;

      const dueDate = paymentDate ?? billingPeriodStart;

      if (opts.dryRun) {
        details.push({
          customerPayrollId: payroll.customerPayrollId,
          status: "succeeded",
          dryRun: true,
          planned: {
            invoiceStatus: statusMap.invoiceStatus,
            chargeStatus: statusMap.chargeStatus ?? null,
            lineItemCount: lineItemRows.length,
            ledgerPairCount: statusMap.ledgerPairCount,
            totalCents: finalTotalCents,
            paidAt: paidAt ? paidAt.toISOString() : null,
          },
        });
        succeededCount++;
        continue;
      }

      // P8 doesn't apply to payrolls writer per spec (only charges) but we still
      // need a payment method for charge rows when statusMap.createCharge.
      if (statusMap.createCharge && !defaultPmId) {
        details.push({
          customerPayrollId: payroll.customerPayrollId,
          status: "failed",
          reason: "no_payment_method",
        });
        return {
          status: "failed",
          reason: "no_payment_method",
          error: `payroll ${payroll.customerPayrollId} requires payment method but customer has none`,
        };
      }

      let chargeId: string | undefined;
      try {
        await this.db.transaction(async (tx) => {
          await tx.insert(invoices).values({
            id: invoiceId,
            customerId: input.billingCustomerId,
            subscriptionId: null,
            type: "recurring",
            status: statusMap.invoiceStatus,
            totalAmountCents: finalTotalCents,
            currency,
            billingPeriodStart,
            billingPeriodEnd,
            dueDate,
            paidAt,
            voidedAt,
            metadata: {
              monolith_payroll_id: payroll.customerPayrollId,
              failure_reason: payroll.failureReason ?? null,
              // Credit-applied adjustment from monolith Customer_Payroll.Starting_Balance.
              // Sign preserved verbatim (negative when credit was applied). Read by PDF/webview
              // adapters as the authoritative credit applied on this historical invoice.
              creditAdjustmentCents: toCentsOrNull(payroll.startingBalance),
              // Monolith provenance for cross-system reconciliation; not used by live billing.
              monolith_invoice_id: payroll.invoiceId ?? null,
              monolith_invoice_url: payroll.invoiceUrl ?? null,
              monolith_reference_number: payroll.referenceNumber ?? null,
              // Verbatim lowercase-trimmed Customer_Payroll.Status from monolith.
              // Read by monolith billingServiceAdapter.statusForApi to preserve the
              // pre-migration API status contract (e.g. "pending"/"un-paid"/"paid"
              // stays surfaced as the same string post-migration).
              monolith_original_status:
                (payroll.status ?? "").toLowerCase().trim() || null,
            },
            createdAt: now,
            updatedAt: now,
          });

          for (const li of lineItemRows) {
            await tx.insert(invoiceLineItems).values({
              id: li.id,
              invoiceId,
              type: li.type,
              description: li.description,
              amountCents: li.amountCents,
              quantity: li.quantity,
              breakdown: li.breakdown as never,
              createdAt: li.createdAt,
            });
          }

          if (statusMap.createCharge && defaultPmId) {
            chargeId = generateId();
            await tx.insert(chargesTable).values({
              id: chargeId,
              invoiceId,
              customerId: input.billingCustomerId,
              paymentMethodId: defaultPmId,
              amountCents: Math.abs(finalTotalCents),
              currency,
              status: statusMap.chargeStatus!,
              stripePaymentIntentId: null,
              idempotencyKey: `mig_payroll_${payroll.customerPayrollId}`,
              failureReason: payroll.failureReason ?? null,
              attemptNumber: 1,
              createdAt: now,
              updatedAt: now,
            });
          }

          const correlationId = `customer-migration-${opts.runId}`;
          const ledgerAmount = Math.abs(finalTotalCents);

          if (ledgerAmount > 0) {
            if (statusMap.invoiceStatus === "paid") {
              await this.ledgerService.recordMigrationPayrollFinalized(
                invoiceId,
                ledgerAmount,
                currency,
                payroll.customerPayrollId,
                correlationId,
                tx,
              );
              await this.ledgerService.recordMigrationPayrollPayment(
                invoiceId,
                ledgerAmount,
                currency,
                payroll.customerPayrollId,
                correlationId,
                tx,
              );
            } else if (statusMap.invoiceStatus === "finalized") {
              await this.ledgerService.recordMigrationPayrollFinalized(
                invoiceId,
                ledgerAmount,
                currency,
                payroll.customerPayrollId,
                correlationId,
                tx,
              );
            } else if (statusMap.invoiceStatus === "void") {
              // Void payroll: AR→Rev finalize + Rev→AR voided. Pair nets to zero
              // on the forward write. `recordInvoiceVoided` writes the Rev→AR
              // reversal half without requiring a numeric monolith id.
              await this.ledgerService.recordMigrationPayrollFinalized(
                invoiceId,
                ledgerAmount,
                currency,
                payroll.customerPayrollId,
                correlationId,
                tx,
              );
              await this.ledgerService.recordInvoiceVoided(
                invoiceId,
                ledgerAmount,
                currency,
                correlationId,
                tx,
              );
            }
          }
        });

        details.push({
          customerPayrollId: payroll.customerPayrollId,
          status: "succeeded",
          invoiceId,
          chargeId: chargeId ?? null,
          invoiceStatus: statusMap.invoiceStatus,
          totalCents: finalTotalCents,
        });
        succeededCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error({
          action: "customer-migration.payrolls.tx_failed",
          customerPayrollId: payroll.customerPayrollId,
          error: msg,
        });
        return {
          status: "failed",
          reason: "payroll_tx_failed",
          error: msg,
        };
      }
    }

    return {
      status: "succeeded",
      data: { succeeded: succeededCount, skipped: skippedCount },
      details,
    };
  }
}
