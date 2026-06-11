import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  HttpStatus,
} from "@nestjs/common";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { generateId } from "../common/utils/uuid.util";
import { BillingException } from "../common/exceptions/billing.exception";
import { LedgerAccountsRepository } from "./ledger-accounts.repository";
import { LedgerEntriesRepository } from "./ledger-entries.repository";
import { ledgerEntries } from "../database/schema/ledger-entries";

type ReferenceType =
  | "invoice"
  | "invoice_void"
  | "payment"
  | "refund"
  | "credit_note"
  | "credit_application"
  | "migration";

type LedgerEntry = typeof ledgerEntries.$inferSelect;

@Injectable()
export class LedgerService implements OnModuleInit {
  private readonly logger = new Logger(LedgerService.name);
  private accountIds = new Map<string, string>();

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    private readonly ledgerAccountsRepo: LedgerAccountsRepository,
    private readonly ledgerEntriesRepo: LedgerEntriesRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const accounts = await this.ledgerAccountsRepo.findAll();
    this.accountIds = new Map(accounts.map((a) => [a.name, a.id]));
    this.logger.log(`Loaded ${this.accountIds.size} ledger accounts`);
  }

  async recordInvoiceFinalized(
    invoiceId: string,
    amountCents: number,
    currency: string,
    correlationId: string,
    tx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    return this.createEntry(
      "accounts_receivable",
      "revenue",
      amountCents,
      currency,
      "invoice",
      invoiceId,
      "Invoice finalized",
      correlationId,
      tx,
    );
  }

  async recordPaymentSucceeded(
    paymentId: string,
    amountCents: number,
    currency: string,
    correlationId: string,
    tx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    return this.createEntry(
      "cash",
      "accounts_receivable",
      amountCents,
      currency,
      "payment",
      paymentId,
      "Payment succeeded",
      correlationId,
      tx,
    );
  }

  async recordCreditNoteIssued(
    creditNoteId: string,
    amountCents: number,
    currency: string,
    correlationId: string,
    tx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    return this.createEntry(
      "credits",
      "accounts_receivable",
      amountCents,
      currency,
      "credit_note",
      creditNoteId,
      "Credit note issued",
      correlationId,
      tx,
    );
  }

  /**
   * Reverses a previously issued credit (used by set-balance flow when admin
   * lowers a customer's balance). Swaps the debit/credit accounts of
   * recordCreditNoteIssued; amountCents must be the positive magnitude.
   */
  async recordCreditNoteReversed(
    creditNoteId: string,
    amountCents: number,
    currency: string,
    correlationId: string,
    tx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    return this.createEntry(
      "accounts_receivable",
      "credits",
      amountCents,
      currency,
      "credit_note",
      creditNoteId,
      "Credit note reversed",
      correlationId,
      tx,
    );
  }

  async recordCreditApplied(
    invoiceId: string,
    amountCents: number,
    currency: string,
    correlationId: string,
    tx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    return this.createEntry(
      "accounts_receivable",
      "credits",
      amountCents,
      currency,
      "credit_application",
      invoiceId,
      "Credit applied to invoice",
      correlationId,
      tx,
    );
  }

  async recordInvoiceVoided(
    invoiceId: string,
    amountCents: number,
    currency: string,
    correlationId: string,
    tx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    return this.createEntry(
      "revenue",
      "accounts_receivable",
      amountCents,
      currency,
      "invoice_void",
      invoiceId,
      "Invoice voided",
      correlationId,
      tx,
    );
  }

  async recordMigrationInvoiceFinalized(
    invoiceId: string,
    amountCents: number,
    currency: string,
    monolithChargeId: number,
    correlationId: string,
    tx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    return this.createEntry(
      "accounts_receivable",
      "revenue",
      amountCents,
      currency,
      "migration",
      invoiceId,
      `Historical migration from monolith charge #${monolithChargeId}`,
      correlationId,
      tx,
    );
  }

  async recordMigrationPayment(
    invoiceId: string,
    amountCents: number,
    currency: string,
    monolithChargeId: number,
    correlationId: string,
    tx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    return this.createEntry(
      "cash",
      "accounts_receivable",
      amountCents,
      currency,
      "migration",
      invoiceId,
      `Historical migration payment from monolith charge #${monolithChargeId}`,
      correlationId,
      tx,
    );
  }

  async recordMigrationPayrollFinalized(
    invoiceId: string,
    amountCents: number,
    currency: string,
    monolithPayrollId: string,
    correlationId: string,
    tx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    return this.createEntry(
      "accounts_receivable",
      "revenue",
      amountCents,
      currency,
      "migration",
      invoiceId,
      `Historical migration from monolith payroll #${monolithPayrollId}`,
      correlationId,
      tx,
    );
  }

  async recordMigrationPayrollPayment(
    invoiceId: string,
    amountCents: number,
    currency: string,
    monolithPayrollId: string,
    correlationId: string,
    tx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    return this.createEntry(
      "cash",
      "accounts_receivable",
      amountCents,
      currency,
      "migration",
      invoiceId,
      `Historical migration payment from monolith payroll #${monolithPayrollId}`,
      correlationId,
      tx,
    );
  }

  async recordRefundSucceeded(
    refundId: string,
    amountCents: number,
    currency: string,
    correlationId: string,
    tx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    return this.createEntry(
      "refunds",
      "cash",
      amountCents,
      currency,
      "refund",
      refundId,
      "Refund succeeded",
      correlationId,
      tx,
    );
  }

  /**
   * Inserts a direction-mirrored reversal of an existing ledger entry.
   * Swaps debit_account_id ↔ credit_account_id; preserves amountCents,
   * currency, referenceType, referenceId, and correlationId (carries audit
   * pairing forward). Description prefixed `Rollback of migration entry:`.
   *
   * Canonical reversal helper for the customer-migration cleanup path.
   * The legacy `recordMigrationVoidReversal` stays for `src/migration/*`.
   */
  async recordReversedEntry(
    originalRow: LedgerEntry,
    tx: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    if (originalRow.amountCents <= 0) {
      throw new BillingException(
        `Ledger entry amount must be positive, got: ${originalRow.amountCents}`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const id = generateId();
    const entryData = {
      id,
      debitAccountId: originalRow.creditAccountId,
      creditAccountId: originalRow.debitAccountId,
      amountCents: originalRow.amountCents,
      currency: originalRow.currency,
      referenceType: originalRow.referenceType,
      referenceId: originalRow.referenceId,
      description: `Rollback of migration entry: ${originalRow.description ?? "(no description)"}`,
      correlationId: originalRow.correlationId,
      createdAt: new Date(),
    };

    await this.ledgerEntriesRepo.createInTx(
      entryData,
      tx as unknown as Parameters<typeof this.ledgerEntriesRepo.createInTx>[1],
    );

    this.logger.log({
      message: "Ledger reversal entry created",
      ledgerEntryId: id,
      reverseOf: originalRow.id,
      debitAccountId: entryData.debitAccountId,
      creditAccountId: entryData.creditAccountId,
      amount: entryData.amountCents,
      referenceType: entryData.referenceType,
      referenceId: entryData.referenceId,
      correlationId: entryData.correlationId,
    });

    return id;
  }

  async recordMigrationVoidReversal(
    invoiceId: string,
    amountCents: number,
    currency: string,
    monolithChargeId: number,
    correlationId: string,
    tx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    return this.createEntry(
      "revenue",
      "accounts_receivable",
      amountCents,
      currency,
      "migration",
      invoiceId,
      `Historical migration void reversal from monolith charge #${monolithChargeId}`,
      correlationId,
      tx,
    );
  }

  private async createEntry(
    debitAccountName: string,
    creditAccountName: string,
    amountCents: number,
    currency: string,
    referenceType: ReferenceType,
    referenceId: string,
    description: string,
    correlationId: string,
    externalTx?: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<string> {
    if (amountCents <= 0) {
      throw new BillingException(
        `Ledger entry amount must be positive, got: ${amountCents}`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const debitAccountId = this.getAccountId(debitAccountName);
    const creditAccountId = this.getAccountId(creditAccountName);
    const id = generateId();

    const entryData = {
      id,
      debitAccountId,
      creditAccountId,
      amountCents,
      currency,
      referenceType,
      referenceId,
      description,
      correlationId,
      createdAt: new Date(),
    };

    if (externalTx) {
      await this.ledgerEntriesRepo.createInTx(
        entryData,
        externalTx as unknown as Parameters<
          typeof this.ledgerEntriesRepo.createInTx
        >[1],
      );
    } else {
      await this.db.transaction(async (tx) => {
        await this.ledgerEntriesRepo.createInTx(entryData, tx);
      });
    }

    this.logger.log({
      message: "Ledger entry created",
      ledgerEntryId: id,
      debitAccount: debitAccountName,
      creditAccount: creditAccountName,
      amount: amountCents,
      referenceType,
      referenceId,
      correlationId,
    });

    return id;
  }

  private getAccountId(name: string): string {
    const id = this.accountIds.get(name);
    if (!id) {
      throw new BillingException(
        `Ledger account not found: ${name}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return id;
  }
}
