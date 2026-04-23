import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { CreditsService } from "./credits.service";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import { CustomersService } from "../customers/customers.service";
import { LedgerService } from "../ledger/ledger.service";
import { InvoicesRepository } from "../invoices/invoices.repository";
import { CreditNotesRepository } from "./credit-notes.repository";
import { CreditBalancesRepository } from "./credit-balances.repository";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import { InvoiceNotFoundException } from "../invoices/invoice-not-found.exception";
import { CreditExceedsInvoiceException } from "../common/exceptions/credit-exceeds-invoice.exception";
import type { IssueCreditNoteDto } from "./dto/issue-credit-note.dto";

describe("CreditsService", () => {
  let service: CreditsService;
  let mockCustomersService: { findById: jest.Mock };
  let mockLedgerService: {
    recordCreditNoteIssued: jest.Mock;
    recordCreditApplied: jest.Mock;
  };
  let mockInvoicesRepo: {
    findById: jest.Mock;
    update: jest.Mock;
    createLineItem: jest.Mock;
  };
  let mockCreditNotesRepo: {
    createInTx: jest.Mock;
    findByCustomer: jest.Mock;
  };
  let mockCreditBalancesRepo: {
    findByCustomer: jest.Mock;
    findByCustomerInTx: jest.Mock;
    upsertInTx: jest.Mock;
    deductInTx: jest.Mock;
  };

  const txMock = {};

  const mockDb = {
    transaction: jest.fn((cb: (tx: typeof txMock) => Promise<void>) =>
      cb(txMock),
    ),
  };

  const MOCK_CUSTOMER = {
    id: "c0000000-0000-4000-a000-000000000001",
    monolithCustomerId: "mono-001",
    stripeCustomerId: "cus_001",
    name: "Test Customer",
    email: "test@example.com",
    status: "active",
    metadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const MOCK_INVOICE = {
    id: "a0000000-0000-4000-a000-000000000010",
    customerId: MOCK_CUSTOMER.id,
    totalAmountCents: 5000,
    currency: "usd",
    status: "finalized",
  };

  const MOCK_DTO: IssueCreditNoteDto = {
    customerId: MOCK_CUSTOMER.id,
    invoiceId: MOCK_INVOICE.id,
    amountCents: 2000,
    reason: "Billing adjustment",
    createdBy: "admin-user",
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockCustomersService = {
      findById: jest.fn().mockResolvedValue(MOCK_CUSTOMER),
    };

    mockLedgerService = {
      recordCreditNoteIssued: jest.fn().mockResolvedValue("ledger-entry-001"),
      recordCreditApplied: jest.fn().mockResolvedValue("ledger-entry-002"),
    };

    mockInvoicesRepo = {
      findById: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
      createLineItem: jest.fn().mockResolvedValue(undefined),
    };

    mockCreditNotesRepo = {
      createInTx: jest.fn().mockResolvedValue(undefined),
      findByCustomer: jest.fn().mockResolvedValue([]),
    };

    mockCreditBalancesRepo = {
      findByCustomer: jest.fn().mockResolvedValue(null),
      findByCustomerInTx: jest.fn().mockResolvedValue(null),
      upsertInTx: jest.fn().mockResolvedValue(undefined),
      deductInTx: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        CreditsService,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
        { provide: InvoicesRepository, useValue: mockInvoicesRepo },
        { provide: CustomersService, useValue: mockCustomersService },
        { provide: LedgerService, useValue: mockLedgerService },
        { provide: CreditNotesRepository, useValue: mockCreditNotesRepo },
        { provide: CreditBalancesRepository, useValue: mockCreditBalancesRepo },
      ],
    }).compile();

    module.useLogger(new Logger());
    service = module.get<CreditsService>(CreditsService);
  });

  describe("issueCreditNote", () => {
    beforeEach(() => {
      // Invoice lookup now uses InvoicesRepository.findById
      mockInvoicesRepo.findById.mockResolvedValue(MOCK_INVOICE);
    });

    it("should create credit note, upsert balance, record ledger, and return response", async () => {
      const result = await service.issueCreditNote(MOCK_DTO, "corr-001");

      expect(result).toMatchObject({
        customerId: MOCK_DTO.customerId,
        invoiceId: MOCK_DTO.invoiceId,
        amountCents: MOCK_DTO.amountCents,
        currency: "usd",
        reason: MOCK_DTO.reason,
        status: "issued",
        createdBy: "admin-user",
      });
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();

      // Verify invoice lookup via repository
      expect(mockInvoicesRepo.findById).toHaveBeenCalledWith(
        MOCK_DTO.invoiceId,
      );

      // Verify transaction was used
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);

      // Verify credit note created via repository
      expect(mockCreditNotesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: MOCK_DTO.customerId,
          invoiceId: MOCK_DTO.invoiceId,
          amountCents: MOCK_DTO.amountCents,
        }),
        txMock,
      );

      // Verify credit balance upserted via repository
      expect(mockCreditBalancesRepo.upsertInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: MOCK_DTO.customerId,
          balanceCents: MOCK_DTO.amountCents,
        }),
        MOCK_DTO.amountCents,
        txMock,
      );

      // Verify ledger entry created within transaction
      expect(mockLedgerService.recordCreditNoteIssued).toHaveBeenCalledWith(
        result.id,
        MOCK_DTO.amountCents,
        "usd",
        "corr-001",
        txMock,
      );
    });

    it("should throw CustomerNotFoundException when customer not found", async () => {
      mockCustomersService.findById.mockResolvedValue(null);

      await expect(
        service.issueCreditNote(MOCK_DTO, "corr-001"),
      ).rejects.toThrow(CustomerNotFoundException);

      // Invoice lookup should NOT be called when customer is missing
      expect(mockInvoicesRepo.findById).not.toHaveBeenCalled();
    });

    it("should throw InvoiceNotFoundException when invoice not found", async () => {
      mockInvoicesRepo.findById.mockResolvedValue(null);

      await expect(
        service.issueCreditNote(MOCK_DTO, "corr-001"),
      ).rejects.toThrow(InvoiceNotFoundException);
    });

    it("should throw CreditExceedsInvoiceException when amount exceeds invoice total", async () => {
      const dto = { ...MOCK_DTO, amountCents: 10000 };

      await expect(service.issueCreditNote(dto, "corr-001")).rejects.toThrow(
        CreditExceedsInvoiceException,
      );
    });

    it("should throw InvoiceNotFoundException when invoice belongs to different customer", async () => {
      mockInvoicesRepo.findById.mockResolvedValue({
        ...MOCK_INVOICE,
        customerId: "c0000000-0000-4000-a000-000000000099",
      });

      await expect(
        service.issueCreditNote(MOCK_DTO, "corr-001"),
      ).rejects.toThrow(InvoiceNotFoundException);
    });

    it("should handle first credit for customer via upsert", async () => {
      await service.issueCreditNote(MOCK_DTO, "corr-001");

      expect(mockCreditBalancesRepo.upsertInTx).toHaveBeenCalledTimes(1);
    });

    it("should handle additional credit by incrementing existing balance via upsert", async () => {
      await service.issueCreditNote(MOCK_DTO, "corr-001");

      // Verify upsertInTx was called with the increment amount
      expect(mockCreditBalancesRepo.upsertInTx).toHaveBeenCalledWith(
        expect.any(Object),
        MOCK_DTO.amountCents,
        txMock,
      );
    });

    it("should perform all 3 operations in a single transaction", async () => {
      await service.issueCreditNote(MOCK_DTO, "corr-001");

      // Transaction was called exactly once
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);

      // Within the transaction: credit note + balance upsert + ledger call
      expect(mockCreditNotesRepo.createInTx).toHaveBeenCalledTimes(1);
      expect(mockCreditBalancesRepo.upsertInTx).toHaveBeenCalledTimes(1);
      expect(mockLedgerService.recordCreditNoteIssued).toHaveBeenCalledTimes(1);

      // Ledger was called with the tx mock
      expect(mockLedgerService.recordCreditNoteIssued).toHaveBeenCalledWith(
        expect.any(String),
        MOCK_DTO.amountCents,
        "usd",
        "corr-001",
        txMock,
      );
    });

    it("should log structured credit.issued entry with all required fields", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "log");

      const result = await service.issueCreditNote(MOCK_DTO, "corr-001");

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          creditNoteId: result.id,
          customerId: MOCK_DTO.customerId,
          invoiceId: MOCK_DTO.invoiceId,
          amount: MOCK_DTO.amountCents,
          action: "credit.issued",
          correlationId: "corr-001",
        }),
      );

      logSpy.mockRestore();
    });

    it("should set createdBy to null when not provided", async () => {
      const dto = { ...MOCK_DTO };
      delete dto.createdBy;

      const result = await service.issueCreditNote(dto, "corr-001");

      expect(result.createdBy).toBeNull();
    });

    it("should create credit note without invoiceId (general account credit)", async () => {
      const dto = { ...MOCK_DTO };
      delete (dto as any).invoiceId;

      const result = await service.issueCreditNote(dto, "corr-no-inv");

      expect(result.invoiceId).toBeNull();
      expect(mockInvoicesRepo.findById).not.toHaveBeenCalled();
      expect(mockCreditNotesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: null }),
        txMock,
      );
      expect(mockCreditBalancesRepo.upsertInTx).toHaveBeenCalled();
      expect(mockLedgerService.recordCreditNoteIssued).toHaveBeenCalled();
    });

    it("should skip invoice validation when invoiceId is null", async () => {
      const dto = {
        customerId: MOCK_CUSTOMER.id,
        amountCents: 5000,
        reason: "Goodwill credit",
      };

      await service.issueCreditNote(dto, "corr-skip-val");

      expect(mockInvoicesRepo.findById).not.toHaveBeenCalled();
    });
  });

  describe("getCreditBalance", () => {
    it("should return existing balance", async () => {
      mockCreditBalancesRepo.findByCustomer.mockResolvedValue({
        id: "bal-001",
        customerId: MOCK_CUSTOMER.id,
        balanceCents: 5000,
        currency: "usd",
        updatedAt: new Date("2026-01-15T00:00:00.000Z"),
      });

      const result = await service.getCreditBalance(MOCK_CUSTOMER.id);

      expect(result).toEqual({
        customerId: MOCK_CUSTOMER.id,
        balanceCents: 5000,
        currency: "usd",
        updatedAt: "2026-01-15T00:00:00.000Z",
      });
    });

    it("should return zero balance when no record exists", async () => {
      mockCreditBalancesRepo.findByCustomer.mockResolvedValue(null);

      const result = await service.getCreditBalance(MOCK_CUSTOMER.id);

      expect(result).toEqual({
        customerId: MOCK_CUSTOMER.id,
        balanceCents: 0,
        currency: "usd",
        updatedAt: null,
      });
    });

    it("should throw CustomerNotFoundException when customer not found", async () => {
      mockCustomersService.findById.mockResolvedValue(null);

      await expect(service.getCreditBalance(MOCK_CUSTOMER.id)).rejects.toThrow(
        CustomerNotFoundException,
      );
    });
  });

  describe("getCreditNotesForCustomer", () => {
    it("should return list of credit notes", async () => {
      mockCreditNotesRepo.findByCustomer.mockResolvedValue([
        {
          id: "cn-001",
          customerId: MOCK_CUSTOMER.id,
          invoiceId: MOCK_INVOICE.id,
          amountCents: 2000,
          currency: "usd",
          reason: "Adjustment",
          status: "issued",
          createdBy: "admin",
          createdAt: new Date("2026-01-15T00:00:00.000Z"),
        },
      ]);

      const result = await service.getCreditNotesForCustomer(MOCK_CUSTOMER.id);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "cn-001",
        customerId: MOCK_CUSTOMER.id,
        invoiceId: MOCK_INVOICE.id,
        amountCents: 2000,
        currency: "usd",
        reason: "Adjustment",
        status: "issued",
        createdBy: "admin",
        createdAt: "2026-01-15T00:00:00.000Z",
      });
    });

    it("should throw CustomerNotFoundException when customer not found", async () => {
      mockCustomersService.findById.mockResolvedValue(null);

      await expect(
        service.getCreditNotesForCustomer(MOCK_CUSTOMER.id),
      ).rejects.toThrow(CustomerNotFoundException);
    });
  });

  describe("applyCreditsToInvoice", () => {
    const INVOICE_ID = "a0000000-0000-4000-a000-000000000010";
    const CUSTOMER_ID = MOCK_CUSTOMER.id;
    const INVOICE_TOTAL = 5000;
    const CURRENCY = "usd";
    const CORRELATION_ID = "corr-apply-001";
    const txApplyMock = { some: "tx" };

    it("should return no-op when customer has zero credit balance", async () => {
      mockCreditBalancesRepo.findByCustomerInTx.mockResolvedValue({
        id: "bal-001",
        customerId: CUSTOMER_ID,
        balanceCents: 0,
        currency: "usd",
        updatedAt: new Date(),
      });

      const result = await service.applyCreditsToInvoice(
        INVOICE_ID,
        CUSTOMER_ID,
        INVOICE_TOTAL,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock as never,
      );

      expect(result).toEqual({ creditApplied: 0, newTotal: INVOICE_TOTAL });
      expect(mockInvoicesRepo.createLineItem).not.toHaveBeenCalled();
      expect(mockInvoicesRepo.update).not.toHaveBeenCalled();
      expect(mockCreditBalancesRepo.deductInTx).not.toHaveBeenCalled();
      expect(mockLedgerService.recordCreditApplied).not.toHaveBeenCalled();
    });

    it("should return no-op when no credit balance record exists", async () => {
      mockCreditBalancesRepo.findByCustomerInTx.mockResolvedValue(null);

      const result = await service.applyCreditsToInvoice(
        INVOICE_ID,
        CUSTOMER_ID,
        INVOICE_TOTAL,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock as never,
      );

      expect(result).toEqual({ creditApplied: 0, newTotal: INVOICE_TOTAL });
      expect(mockInvoicesRepo.createLineItem).not.toHaveBeenCalled();
      expect(mockInvoicesRepo.update).not.toHaveBeenCalled();
      expect(mockCreditBalancesRepo.deductInTx).not.toHaveBeenCalled();
    });

    it("should apply partial credit when balance is less than invoice total", async () => {
      mockCreditBalancesRepo.findByCustomerInTx.mockResolvedValue({
        id: "bal-001",
        customerId: CUSTOMER_ID,
        balanceCents: 3000,
        currency: "usd",
        updatedAt: new Date(),
      });

      const result = await service.applyCreditsToInvoice(
        INVOICE_ID,
        CUSTOMER_ID,
        INVOICE_TOTAL,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock as never,
      );

      expect(result).toEqual({ creditApplied: 3000, newTotal: 2000 });

      // Verify credit_applied line item inserted via repository
      expect(mockInvoicesRepo.createLineItem).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: INVOICE_ID,
          type: "credit_applied",
          description: "Credit applied from balance",
          amountCents: -3000,
          quantity: 1,
        }),
        txApplyMock,
      );

      // Verify invoice total updated via repository
      expect(mockInvoicesRepo.update).toHaveBeenCalledWith(
        INVOICE_ID,
        expect.objectContaining({
          totalAmountCents: 2000,
        }),
        txApplyMock,
      );

      // Verify credit balance deducted via repository
      expect(mockCreditBalancesRepo.deductInTx).toHaveBeenCalledWith(
        CUSTOMER_ID,
        3000,
        txApplyMock,
      );

      // Verify ledger entry
      expect(mockLedgerService.recordCreditApplied).toHaveBeenCalledWith(
        INVOICE_ID,
        3000,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock,
      );
    });

    it("should apply full credit when balance equals invoice total", async () => {
      mockCreditBalancesRepo.findByCustomerInTx.mockResolvedValue({
        id: "bal-001",
        customerId: CUSTOMER_ID,
        balanceCents: 5000,
        currency: "usd",
        updatedAt: new Date(),
      });

      const result = await service.applyCreditsToInvoice(
        INVOICE_ID,
        CUSTOMER_ID,
        INVOICE_TOTAL,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock as never,
      );

      expect(result).toEqual({ creditApplied: 5000, newTotal: 0 });

      expect(mockInvoicesRepo.createLineItem).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: -5000,
        }),
        txApplyMock,
      );

      expect(mockInvoicesRepo.update).toHaveBeenCalledWith(
        INVOICE_ID,
        expect.objectContaining({
          totalAmountCents: 0,
        }),
        txApplyMock,
      );

      expect(mockLedgerService.recordCreditApplied).toHaveBeenCalledWith(
        INVOICE_ID,
        5000,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock,
      );
    });

    it("should apply only invoice total when credit exceeds invoice", async () => {
      mockCreditBalancesRepo.findByCustomerInTx.mockResolvedValue({
        id: "bal-001",
        customerId: CUSTOMER_ID,
        balanceCents: 10000,
        currency: "usd",
        updatedAt: new Date(),
      });

      const result = await service.applyCreditsToInvoice(
        INVOICE_ID,
        CUSTOMER_ID,
        INVOICE_TOTAL,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock as never,
      );

      expect(result).toEqual({ creditApplied: 5000, newTotal: 0 });

      // Should only apply invoice total, not full balance
      expect(mockInvoicesRepo.createLineItem).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: -5000,
        }),
        txApplyMock,
      );

      expect(mockInvoicesRepo.update).toHaveBeenCalledWith(
        INVOICE_ID,
        expect.objectContaining({
          totalAmountCents: 0,
        }),
        txApplyMock,
      );

      expect(mockLedgerService.recordCreditApplied).toHaveBeenCalledWith(
        INVOICE_ID,
        5000,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock,
      );
    });

    it("should use the provided transaction for all operations", async () => {
      mockCreditBalancesRepo.findByCustomerInTx.mockResolvedValue({
        id: "bal-001",
        customerId: CUSTOMER_ID,
        balanceCents: 2000,
        currency: "usd",
        updatedAt: new Date(),
      });

      await service.applyCreditsToInvoice(
        INVOICE_ID,
        CUSTOMER_ID,
        INVOICE_TOTAL,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock as never,
      );

      // Credit balance SELECT goes through repository with tx
      expect(mockCreditBalancesRepo.findByCustomerInTx).toHaveBeenCalledWith(
        CUSTOMER_ID,
        txApplyMock,
      );

      // Invoice line item and invoice update go through repository with tx
      expect(mockInvoicesRepo.createLineItem).toHaveBeenCalledWith(
        expect.any(Object),
        txApplyMock,
      );
      expect(mockInvoicesRepo.update).toHaveBeenCalledWith(
        INVOICE_ID,
        expect.any(Object),
        txApplyMock,
      );

      // Credit balance deduction goes through repository with tx
      expect(mockCreditBalancesRepo.deductInTx).toHaveBeenCalledWith(
        CUSTOMER_ID,
        2000,
        txApplyMock,
      );

      // Should NOT create its own transaction
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should log structured entry with all required fields", async () => {
      mockCreditBalancesRepo.findByCustomerInTx.mockResolvedValue({
        id: "bal-001",
        customerId: CUSTOMER_ID,
        balanceCents: 3000,
        currency: "usd",
        updatedAt: new Date(),
      });

      const logSpy = jest.spyOn(Logger.prototype, "log");

      await service.applyCreditsToInvoice(
        INVOICE_ID,
        CUSTOMER_ID,
        INVOICE_TOTAL,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock as never,
      );

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: INVOICE_ID,
          customerId: CUSTOMER_ID,
          creditApplied: 3000,
          remainingBalance: 0,
          action: "credit.applied",
          correlationId: CORRELATION_ID,
        }),
      );

      logSpy.mockRestore();
    });

    it("should write creditAdjustmentCents metadata when partial credit applied", async () => {
      mockCreditBalancesRepo.findByCustomerInTx.mockResolvedValue({
        id: "bal-001",
        customerId: CUSTOMER_ID,
        balanceCents: 3000,
        currency: "usd",
        updatedAt: new Date(),
      });

      await service.applyCreditsToInvoice(
        INVOICE_ID,
        CUSTOMER_ID,
        INVOICE_TOTAL,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock as never,
      );

      expect(mockInvoicesRepo.update).toHaveBeenCalledWith(
        INVOICE_ID,
        expect.objectContaining({
          totalAmountCents: 2000,
          metadata: { creditAdjustmentCents: 3000 },
        }),
        txApplyMock,
      );
    });

    it("should write creditAdjustmentCents metadata when full credit applied (balance equals total)", async () => {
      mockCreditBalancesRepo.findByCustomerInTx.mockResolvedValue({
        id: "bal-001",
        customerId: CUSTOMER_ID,
        balanceCents: 5000,
        currency: "usd",
        updatedAt: new Date(),
      });

      await service.applyCreditsToInvoice(
        INVOICE_ID,
        CUSTOMER_ID,
        INVOICE_TOTAL,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock as never,
      );

      expect(mockInvoicesRepo.update).toHaveBeenCalledWith(
        INVOICE_ID,
        expect.objectContaining({
          totalAmountCents: 0,
          metadata: { creditAdjustmentCents: 5000 },
        }),
        txApplyMock,
      );
    });

    it("should write creditAdjustmentCents capped at invoice total when credit exceeds invoice", async () => {
      mockCreditBalancesRepo.findByCustomerInTx.mockResolvedValue({
        id: "bal-001",
        customerId: CUSTOMER_ID,
        balanceCents: 10000,
        currency: "usd",
        updatedAt: new Date(),
      });

      await service.applyCreditsToInvoice(
        INVOICE_ID,
        CUSTOMER_ID,
        INVOICE_TOTAL,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock as never,
      );

      // creditAdjustmentCents should be the invoice total (5000), not the full balance (10000)
      expect(mockInvoicesRepo.update).toHaveBeenCalledWith(
        INVOICE_ID,
        expect.objectContaining({
          totalAmountCents: 0,
          metadata: { creditAdjustmentCents: 5000 },
        }),
        txApplyMock,
      );
    });

    it("should match creditAdjustmentCents to the absolute value of the line item amount", async () => {
      mockCreditBalancesRepo.findByCustomerInTx.mockResolvedValue({
        id: "bal-001",
        customerId: CUSTOMER_ID,
        balanceCents: 2500,
        currency: "usd",
        updatedAt: new Date(),
      });

      await service.applyCreditsToInvoice(
        INVOICE_ID,
        CUSTOMER_ID,
        INVOICE_TOTAL,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock as never,
      );

      // Line item is -2500, metadata should be 2500 (absolute)
      expect(mockInvoicesRepo.createLineItem).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: -2500,
        }),
        txApplyMock,
      );
      expect(mockInvoicesRepo.update).toHaveBeenCalledWith(
        INVOICE_ID,
        expect.objectContaining({
          metadata: { creditAdjustmentCents: 2500 },
        }),
        txApplyMock,
      );
    });

    it("should NOT write metadata when no credit balance record exists", async () => {
      mockCreditBalancesRepo.findByCustomerInTx.mockResolvedValue(null);

      await service.applyCreditsToInvoice(
        INVOICE_ID,
        CUSTOMER_ID,
        INVOICE_TOTAL,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock as never,
      );

      expect(mockInvoicesRepo.update).not.toHaveBeenCalled();
    });

    it("should NOT write metadata when customer has zero credit balance", async () => {
      mockCreditBalancesRepo.findByCustomerInTx.mockResolvedValue({
        id: "bal-001",
        customerId: CUSTOMER_ID,
        balanceCents: 0,
        currency: "usd",
        updatedAt: new Date(),
      });

      await service.applyCreditsToInvoice(
        INVOICE_ID,
        CUSTOMER_ID,
        INVOICE_TOTAL,
        CURRENCY,
        CORRELATION_ID,
        txApplyMock as never,
      );

      expect(mockInvoicesRepo.update).not.toHaveBeenCalled();
    });
  });
});
