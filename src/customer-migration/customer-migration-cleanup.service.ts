import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { customers } from "../database/schema/customers";
import { subscriptions } from "../database/schema/subscriptions";
import { creditNotes } from "../database/schema/credit-notes";
import { creditBalances } from "../database/schema/credit-balances";
import { invoices } from "../database/schema/invoices";
import { invoiceLineItems } from "../database/schema/invoice-line-items";
import { charges } from "../database/schema/charges";
import { surchargeConfigs } from "../database/schema/surcharge-configs";
import { paymentMethods } from "../database/schema/payment-methods";
import { gatewayAssignments } from "../database/schema/gateway-assignments";
import { ledgerEntries } from "../database/schema/ledger-entries";
import { generateId } from "../common/utils/uuid.util";
import { LedgerService } from "../ledger/ledger.service";
import { CustomerMigrationLogsRepository } from "./customer-migration-logs.repository";

export interface CleanupResult {
  status: "succeeded" | "skipped" | "failed";
  reason?: string;
  error?: string;
  runId: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class CustomerMigrationCleanupService {
  private readonly logger = new Logger(CustomerMigrationCleanupService.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    private readonly ledgerService: LedgerService,
    private readonly logsRepository: CustomerMigrationLogsRepository,
  ) {}

  async rollback(monolithCustomerId: string): Promise<CleanupResult> {
    const runId = generateId();

    const [customerRow] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.monolithCustomerId, monolithCustomerId))
      .limit(1);

    if (!customerRow) {
      await this.safeLog({
        runId,
        scriptName: "customer-migration-rollback",
        monolithCustomerId,
        billingCustomerId: null,
        status: "skipped",
        details: { reason: "not_migrated" },
      });
      return { status: "skipped", reason: "not_migrated", runId };
    }

    const billingCustomerId = customerRow.id;

    try {
      const reversalCount = await this.db.transaction(async (tx) => {
        // Gather invoice IDs and credit_note IDs for scope filtering on the
        // ledger query. These are the only `referenceId`s that legitimately
        // belong to this customer for migration-correlated rows.
        const invoiceRows = (await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(eq(invoices.customerId, billingCustomerId))) as Array<{
          id: string;
        }>;
        const invoiceIds = invoiceRows.map((r) => r.id);

        const creditNoteRows = (await tx
          .select({ id: creditNotes.id })
          .from(creditNotes)
          .where(eq(creditNotes.customerId, billingCustomerId))) as Array<{
          id: string;
        }>;
        const creditNoteIds = creditNoteRows.map((r) => r.id);

        // B4: Scope = correlationId LIKE 'customer-migration-%' (canonical
        // filter — auto-excludes post-migration runtime entries) AND
        // referenceId in customer's invoices or credit_notes.
        const refSets: ReturnType<typeof eq>[] = [];
        if (invoiceIds.length > 0) {
          refSets.push(inArray(ledgerEntries.referenceId, invoiceIds));
        }
        if (creditNoteIds.length > 0) {
          refSets.push(inArray(ledgerEntries.referenceId, creditNoteIds));
        }

        let reversals = 0;
        if (refSets.length > 0) {
          const rows = (await tx
            .select()
            .from(ledgerEntries)
            .where(
              and(
                like(ledgerEntries.correlationId, "customer-migration-%"),
                or(...refSets),
              ),
            )) as Array<typeof ledgerEntries.$inferSelect>;

          for (const row of rows) {
            // B4: direction-mirrored reversal — swaps debit/credit accounts,
            // preserves correlationId for audit pairing.
            await this.ledgerService.recordReversedEntry(row, tx);
            reversals++;
          }
        }

        // DELETE in reverse FK order.
        // subscriptions
        await tx
          .delete(subscriptions)
          .where(eq(subscriptions.customerId, billingCustomerId));

        // credit_notes
        if (creditNoteIds.length > 0) {
          await tx
            .delete(creditNotes)
            .where(eq(creditNotes.customerId, billingCustomerId));
        }

        // DELETE credit_balances rather than UPDATE balance_cents=0 — the FK on
        // credit_balances.customer_id is ON DELETE NO ACTION, so leaving the row in place
        // would FK-violate when we DELETE the customers row below. Schema unchanged;
        // we just remove the dependent row first.
        await tx
          .delete(creditBalances)
          .where(eq(creditBalances.customerId, billingCustomerId));

        // P12: charges delete is UNCONDITIONAL — do NOT gate on
        // invoiceIds.length. A customer may have failed at an earlier step
        // (e.g., payment-settings + surcharge) before any invoice was
        // written, but the per-customer rollback contract must still try.
        await tx
          .delete(charges)
          .where(eq(charges.customerId, billingCustomerId));

        // invoice_line_items — gated on invoiceIds (FK column is invoiceId).
        if (invoiceIds.length > 0) {
          await tx
            .delete(invoiceLineItems)
            .where(inArray(invoiceLineItems.invoiceId, invoiceIds));
        }

        // invoices
        await tx
          .delete(invoices)
          .where(eq(invoices.customerId, billingCustomerId));

        // surcharge_configs
        await tx
          .delete(surchargeConfigs)
          .where(eq(surchargeConfigs.customerId, billingCustomerId));

        // payment_methods
        await tx
          .delete(paymentMethods)
          .where(eq(paymentMethods.customerId, billingCustomerId));

        // gateway_assignments
        await tx
          .delete(gatewayAssignments)
          .where(eq(gatewayAssignments.customerId, billingCustomerId));

        // customers
        await tx.delete(customers).where(eq(customers.id, billingCustomerId));

        return reversals;
      });

      await this.safeLog({
        runId,
        scriptName: "customer-migration-rollback",
        monolithCustomerId,
        billingCustomerId,
        status: "rolled_back",
        details: { reversalCount },
      });

      return {
        status: "succeeded",
        runId,
        details: { reversalCount, billingCustomerId },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({
        action: "customer-migration.rollback.failed",
        monolithCustomerId,
        error: msg,
      });
      await this.safeLog({
        runId,
        scriptName: "customer-migration-rollback",
        monolithCustomerId,
        billingCustomerId,
        status: "failed",
        errorMessage: msg,
      });
      return { status: "failed", reason: "rollback_failed", error: msg, runId };
    }
  }

  private async safeLog(
    params: Parameters<CustomerMigrationLogsRepository["writeStepLog"]>[0],
  ): Promise<void> {
    try {
      await this.logsRepository.writeStepLog(params);
    } catch (err) {
      this.logger.error({
        action: "customer-migration.rollback.log_write_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
