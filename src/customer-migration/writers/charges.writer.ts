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
import type { ChargeInputDto } from "../dto/migrate-customer-body.dto";

export interface ChargesWriteInput {
  billingCustomerId: string;
  charges: ChargeInputDto[];
}

interface ChargeStatusMap {
  invoiceStatus: "paid" | "finalized" | "void";
  createCharge: boolean;
  chargeStatus?: "succeeded" | "failed" | "pending";
  ledgerPairCount: number;
}

function mapChargeStatus(c: ChargeInputDto): ChargeStatusMap | null {
  if (c.deletedAt) {
    return { invoiceStatus: "void", createCharge: false, ledgerPairCount: 2 };
  }
  const s = (c.paymentStatus ?? "").toLowerCase().trim();
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
    default:
      return null;
  }
}

@Injectable()
export class ChargesWriter {
  private readonly logger = new Logger(ChargesWriter.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    private readonly invoicesRepository: InvoicesRepository,
    private readonly paymentMethodsRepository: PaymentMethodsRepository,
    private readonly ledgerService: LedgerService,
  ) {}

  async write(
    input: ChargesWriteInput,
    opts: { dryRun: boolean; runId: string },
  ): Promise<StepResult & { details?: unknown[] }> {
    if (!input.charges || input.charges.length === 0) {
      return { status: "skipped", reason: "no_charges" };
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

    for (const charge of input.charges) {
      const statusMap = mapChargeStatus(charge);
      if (!statusMap) {
        details.push({
          chargeId: charge.chargeId,
          status: "skipped",
          reason: "unknown_status",
        });
        skippedCount++;
        continue;
      }

      let totalCents: number;
      try {
        totalCents = toCents(charge.amount);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: "failed", reason: "invalid_amount", error: msg };
      }

      // Bug 2 fix: run idempotency check on both real-run AND dry-run so the
      // preview accurately reports already-migrated rows.
      {
        const existing = await this.invoicesRepository.findByMonolithMetadata(
          "monolith_charge_id",
          String(charge.chargeId),
        );
        if (existing) {
          details.push({
            chargeId: charge.chargeId,
            status: "skipped",
            reason: "already_migrated",
          });
          skippedCount++;
          continue;
        }
      }

      // P8: charges writer fails loudly when no PM available for a status that
      // needs a `charges` row insert.
      if (!opts.dryRun && statusMap.createCharge && !defaultPmId) {
        return {
          status: "failed",
          reason: "no_payment_method",
          error: `customer has no payment methods, cannot create charges row for chargeId ${charge.chargeId}`,
        };
      }

      const invoiceId = opts.dryRun ? "<dry-run-invoice>" : generateId();
      const now = new Date();
      const lineItemRows: Array<{
        id: string;
        invoiceId: string;
        type: string;
        description: string;
        amountCents: number;
        quantity: number;
        createdAt: Date;
      }> = [];

      try {
        if (charge.lineItems.length > 0) {
          for (const li of charge.lineItems) {
            const feeCents = toCentsOrNull(li.fee) ?? 0;
            if (feeCents !== 0) {
              lineItemRows.push({
                id: opts.dryRun ? "<dry-run-li>" : generateId(),
                invoiceId,
                type: "base_fee",
                description: li.employeeName
                  ? `Fee: ${li.employeeName}`
                  : (li.notes ?? "Fee"),
                amountCents: feeCents,
                quantity: 1,
                createdAt: now,
              });
            }
            const implCents = toCentsOrNull(li.implementationFee) ?? 0;
            if (implCents !== 0) {
              lineItemRows.push({
                id: opts.dryRun ? "<dry-run-li>" : generateId(),
                invoiceId,
                type: "implementation_fee",
                description: li.employeeName
                  ? `Implementation: ${li.employeeName}`
                  : "Implementation fee",
                amountCents: implCents,
                quantity: 1,
                createdAt: now,
              });
            }
            const discCents = toCentsOrNull(li.discount) ?? 0;
            if (discCents !== 0) {
              lineItemRows.push({
                id: opts.dryRun ? "<dry-run-li>" : generateId(),
                invoiceId,
                type: "discount",
                description: li.employeeName
                  ? `Discount: ${li.employeeName}`
                  : "Discount",
                amountCents: -Math.abs(discCents),
                quantity: 1,
                createdAt: now,
              });
            }
          }
        }

        const surchargeCents = toCentsOrNull(charge.creditCardSurcharge) ?? 0;
        if (surchargeCents !== 0) {
          lineItemRows.push({
            id: opts.dryRun ? "<dry-run-li>" : generateId(),
            invoiceId,
            type: "surcharge",
            description: "Credit card surcharge",
            amountCents: surchargeCents,
            quantity: 1,
            createdAt: now,
          });
        }

        if (lineItemRows.length === 0) {
          lineItemRows.push({
            id: opts.dryRun ? "<dry-run-li>" : generateId(),
            invoiceId,
            type: "base_fee",
            description: "Historical charge from monolith",
            amountCents: Math.abs(totalCents),
            quantity: 1,
            createdAt: now,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: "failed",
          reason: "invalid_line_item",
          error: msg,
        };
      }

      const lineItemSum = lineItemRows.reduce((s, l) => s + l.amountCents, 0);
      // P10: always use monolith-authoritative totalCents as the invoice
      // total. When line items are present, cross-check the sum and warn on
      // mismatch beyond ±1¢ — do NOT silently substitute lineItemSum.
      if (
        lineItemRows.length > 0 &&
        Math.abs(lineItemSum - totalCents) > 1
      ) {
        this.logger.warn({
          action: "charges.writer.line_item_sum_mismatch",
          monolithChargeId: charge.chargeId,
          lineItemSum,
          totalCents,
          delta: lineItemSum - totalCents,
        });
      }
      const absTotalCents = Math.abs(totalCents);

      const invoiceType = charge.chargeType === "ONBOARDING" ? "onboarding" : "one_time";

      const paymentDate = charge.paymentDate
        ? new Date(charge.paymentDate)
        : null;
      // P4
      const paidAt =
        statusMap.invoiceStatus === "paid" ? paymentDate : null;
      const voidedAt =
        statusMap.invoiceStatus === "void" && charge.deletedAt
          ? new Date(charge.deletedAt)
          : null;
      const billingDate = paymentDate ?? now;

      if (opts.dryRun) {
        details.push({
          chargeId: charge.chargeId,
          status: "succeeded",
          dryRun: true,
          planned: {
            invoiceStatus: statusMap.invoiceStatus,
            chargeStatus: statusMap.chargeStatus ?? null,
            invoiceType,
            lineItemCount: lineItemRows.length,
            ledgerPairCount: statusMap.ledgerPairCount,
            totalCents: absTotalCents,
            paidAt: paidAt ? paidAt.toISOString() : null,
          },
        });
        succeededCount++;
        continue;
      }

      let createdChargeId: string | undefined;
      try {
        await this.db.transaction(async (tx) => {
          await tx.insert(invoices).values({
            id: invoiceId,
            customerId: input.billingCustomerId,
            subscriptionId: null,
            type: invoiceType,
            status: statusMap.invoiceStatus,
            totalAmountCents: absTotalCents,
            currency: "usd",
            billingPeriodStart: billingDate,
            billingPeriodEnd: billingDate,
            dueDate: billingDate,
            paidAt,
            voidedAt,
            metadata: {
              monolith_charge_id: charge.chargeId,
              failure_reason: charge.failureReason ?? null,
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
              breakdown: null as never,
              createdAt: li.createdAt,
            });
          }

          if (statusMap.createCharge && defaultPmId) {
            createdChargeId = generateId();
            await tx.insert(chargesTable).values({
              id: createdChargeId,
              invoiceId,
              customerId: input.billingCustomerId,
              paymentMethodId: defaultPmId,
              amountCents: absTotalCents,
              currency: "usd",
              status: statusMap.chargeStatus!,
              stripePaymentIntentId: null,
              idempotencyKey: `mig_charge_${charge.chargeId}`,
              failureReason: charge.failureReason ?? null,
              attemptNumber: 1,
              createdAt: now,
              updatedAt: now,
            });
          }

          const correlationId = `customer-migration-${opts.runId}`;
          // P10: do not floor ledger amount to 1¢ — if the charge is $0 the
          // ledger amount is 0, and ledger writes for $0 are no-op'd below
          // (LedgerService rejects amounts <= 0 anyway).
          const ledgerAmount = absTotalCents;

          if (ledgerAmount === 0) {
            // Nothing to record on the ledger for a $0 charge; the invoice
            // row + line items already capture the historical record.
          } else if (statusMap.invoiceStatus === "paid") {
            await this.ledgerService.recordMigrationInvoiceFinalized(
              invoiceId,
              ledgerAmount,
              "usd",
              charge.chargeId,
              correlationId,
              tx,
            );
            await this.ledgerService.recordMigrationPayment(
              invoiceId,
              ledgerAmount,
              "usd",
              charge.chargeId,
              correlationId,
              tx,
            );
          } else if (statusMap.invoiceStatus === "finalized") {
            await this.ledgerService.recordMigrationInvoiceFinalized(
              invoiceId,
              ledgerAmount,
              "usd",
              charge.chargeId,
              correlationId,
              tx,
            );
          } else if (statusMap.invoiceStatus === "void") {
            await this.ledgerService.recordMigrationInvoiceFinalized(
              invoiceId,
              ledgerAmount,
              "usd",
              charge.chargeId,
              correlationId,
              tx,
            );
            await this.ledgerService.recordMigrationVoidReversal(
              invoiceId,
              ledgerAmount,
              "usd",
              charge.chargeId,
              correlationId,
              tx,
            );
          }
        });

        details.push({
          chargeId: charge.chargeId,
          status: "succeeded",
          invoiceId,
          billingChargeId: createdChargeId ?? null,
          invoiceStatus: statusMap.invoiceStatus,
          totalCents: absTotalCents,
        });
        succeededCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error({
          action: "customer-migration.charges.tx_failed",
          chargeId: charge.chargeId,
          error: msg,
        });
        return {
          status: "failed",
          reason: "charge_tx_failed",
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
