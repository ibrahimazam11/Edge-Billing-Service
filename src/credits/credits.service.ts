import { Inject, Injectable, Logger } from "@nestjs/common";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { CustomersService } from "../customers/customers.service";
import { LedgerService } from "../ledger/ledger.service";
import { InvoicesRepository } from "../invoices/invoices.repository";
import { CreditNotesRepository } from "./credit-notes.repository";
import { CreditBalancesRepository } from "./credit-balances.repository";
import { generateId } from "../common/utils/uuid.util";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import { InvoiceNotFoundException } from "../invoices/invoice-not-found.exception";
import { CreditExceedsInvoiceException } from "../common/exceptions/credit-exceeds-invoice.exception";
import type { IssueCreditNoteDto } from "./dto/issue-credit-note.dto";
import type { CreditNoteResponseDto } from "./dto/credit-note-response.dto";
import type { CreditBalanceResponseDto } from "./dto/credit-balance-response.dto";

export interface CreditApplicationResult {
  creditApplied: number;
  newTotal: number;
}

@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    private readonly invoicesRepository: InvoicesRepository,
    private readonly customersService: CustomersService,
    private readonly ledgerService: LedgerService,
    private readonly creditNotesRepo: CreditNotesRepository,
    private readonly creditBalancesRepo: CreditBalancesRepository,
  ) {}

  async issueCreditNote(
    dto: IssueCreditNoteDto,
    correlationId: string,
  ): Promise<CreditNoteResponseDto> {
    // Validate customer exists
    const customer = await this.customersService.findById(dto.customerId);
    if (!customer) {
      throw new CustomerNotFoundException(dto.customerId);
    }

    // Validate invoice exists (only if invoiceId provided)
    if (dto.invoiceId) {
      const invoice = await this.invoicesRepository.findById(dto.invoiceId);

      if (!invoice || invoice.customerId !== dto.customerId) {
        throw new InvoiceNotFoundException(dto.invoiceId);
      }

      // Validate credit amount does not exceed invoice total
      if (dto.amountCents > invoice.totalAmountCents) {
        throw new CreditExceedsInvoiceException(
          dto.amountCents,
          invoice.totalAmountCents,
        );
      }
    }

    const creditNoteId = generateId();
    const now = new Date();

    // Single transaction: credit note + balance upsert + ledger entry
    await this.db.transaction(async (tx) => {
      // 1. Insert credit note
      await this.creditNotesRepo.createInTx(
        {
          id: creditNoteId,
          customerId: dto.customerId,
          invoiceId: dto.invoiceId ?? null,
          amountCents: dto.amountCents,
          currency: "usd",
          reason: dto.reason,
          status: "issued",
          createdBy: dto.createdBy ?? null,
          createdAt: now,
        },
        tx,
      );

      // 2. Upsert credit balance
      await this.creditBalancesRepo.upsertInTx(
        {
          id: generateId(),
          customerId: dto.customerId,
          balanceCents: dto.amountCents,
          currency: "usd",
          updatedAt: now,
        },
        dto.amountCents,
        tx,
      );

      // 3. Record ledger entry. Positive amount → credit issued (debit credits,
      // credit AR). Negative amount → credit reversal (debit AR, credit credits)
      // posted with the absolute magnitude so the ledger's positive-only guard holds.
      if (dto.amountCents >= 0) {
        await this.ledgerService.recordCreditNoteIssued(
          creditNoteId,
          dto.amountCents,
          "usd",
          correlationId,
          tx,
        );
      } else {
        await this.ledgerService.recordCreditNoteReversed(
          creditNoteId,
          Math.abs(dto.amountCents),
          "usd",
          correlationId,
          tx,
        );
      }
    });

    this.logger.log({
      creditNoteId,
      customerId: dto.customerId,
      invoiceId: dto.invoiceId,
      amount: dto.amountCents,
      action: "credit.issued",
      correlationId,
    });

    return {
      id: creditNoteId,
      customerId: dto.customerId,
      invoiceId: dto.invoiceId ?? null,
      amountCents: dto.amountCents,
      currency: "usd",
      reason: dto.reason,
      status: "issued",
      createdBy: dto.createdBy ?? null,
      createdAt: now.toISOString(),
    };
  }

  async getCreditBalance(
    customerId: string,
  ): Promise<CreditBalanceResponseDto> {
    // Validate customer exists
    const customer = await this.customersService.findById(customerId);
    if (!customer) {
      throw new CustomerNotFoundException(customerId);
    }

    const balance = await this.creditBalancesRepo.findByCustomer(customerId);

    if (!balance) {
      return {
        customerId,
        balanceCents: 0,
        currency: "usd",
        updatedAt: null,
      };
    }

    return {
      customerId: balance.customerId,
      balanceCents: balance.balanceCents,
      currency: balance.currency,
      updatedAt: balance.updatedAt ? balance.updatedAt.toISOString() : null,
    };
  }

  async applyCreditsToInvoice(
    invoiceId: string,
    customerId: string,
    invoiceTotalCents: number,
    currency: string,
    correlationId: string,
    tx: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  ): Promise<CreditApplicationResult> {
    const balance = await this.creditBalancesRepo.findByCustomerInTx(
      customerId,
      tx as unknown as Parameters<
        typeof this.creditBalancesRepo.findByCustomerInTx
      >[1],
    );

    if (!balance || balance.balanceCents === 0) {
      return { creditApplied: 0, newTotal: invoiceTotalCents };
    }

    const creditToApply = Math.min(balance.balanceCents, invoiceTotalCents);
    const newTotal = invoiceTotalCents - creditToApply;
    const remainingBalance = balance.balanceCents - creditToApply;

    // Insert credit_applied line item (negative amount)
    await this.invoicesRepository.createLineItem(
      {
        id: generateId(),
        invoiceId,
        type: "credit_applied",
        description: "Credit applied from balance",
        amountCents: -creditToApply,
        quantity: 1,
        createdAt: new Date(),
      },
      tx,
    );

    // Update invoice total and stamp credit amount into metadata so downstream
    // readers (e.g. the monolith PDF adapter) can render the "Credit Applied" row.
    await this.invoicesRepository.update(
      invoiceId,
      {
        totalAmountCents: newTotal,
        metadata: { creditAdjustmentCents: creditToApply },
        updatedAt: new Date(),
      },
      tx,
    );

    // Deduct credit balance atomically
    await this.creditBalancesRepo.deductInTx(
      customerId,
      creditToApply,
      tx as unknown as Parameters<typeof this.creditBalancesRepo.deductInTx>[2],
    );

    // Record ledger entry for credit application
    await this.ledgerService.recordCreditApplied(
      invoiceId,
      creditToApply,
      currency,
      correlationId,
      tx,
    );

    this.logger.log({
      invoiceId,
      customerId,
      creditApplied: creditToApply,
      remainingBalance,
      action: "credit.applied",
      correlationId,
    });

    return { creditApplied: creditToApply, newTotal };
  }

  async getCreditNotesForCustomer(
    customerId: string,
  ): Promise<CreditNoteResponseDto[]> {
    const customer = await this.customersService.findById(customerId);
    if (!customer) {
      throw new CustomerNotFoundException(customerId);
    }

    const notes = await this.creditNotesRepo.findByCustomer(customerId);

    return notes.map((note) => ({
      id: note.id,
      customerId: note.customerId,
      invoiceId: note.invoiceId,
      amountCents: note.amountCents,
      currency: note.currency,
      reason: note.reason,
      status: note.status,
      createdBy: note.createdBy,
      createdAt: note.createdAt.toISOString(),
    }));
  }
}
