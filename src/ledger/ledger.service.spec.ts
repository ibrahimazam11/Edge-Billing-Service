import { Test } from "@nestjs/testing";
import { HttpStatus, Logger } from "@nestjs/common";
import { LedgerService } from "./ledger.service";
import { LedgerAccountsRepository } from "./ledger-accounts.repository";
import { LedgerEntriesRepository } from "./ledger-entries.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import { BillingException } from "../common/exceptions/billing.exception";

const ACCOUNT_IDS = {
  accounts_receivable: "a0000000-0000-4000-a000-000000000001",
  revenue: "a0000000-0000-4000-a000-000000000002",
  cash: "a0000000-0000-4000-a000-000000000003",
  refunds: "a0000000-0000-4000-a000-000000000004",
  credits: "a0000000-0000-4000-a000-000000000005",
};

const MOCK_ACCOUNTS = Object.entries(ACCOUNT_IDS).map(([name, id]) => ({
  id,
  name,
  type: name,
  description: `Test ${name}`,
  createdAt: new Date(),
}));

describe("LedgerService", () => {
  let service: LedgerService;
  let mockLedgerAccountsRepo: { findAll: jest.Mock };
  let mockLedgerEntriesRepo: { createInTx: jest.Mock };

  const txMock = {};

  const mockDb = {
    transaction: jest.fn((cb: (tx: typeof txMock) => Promise<void>) =>
      cb(txMock),
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockLedgerAccountsRepo = {
      findAll: jest.fn().mockResolvedValue(MOCK_ACCOUNTS),
    };

    mockLedgerEntriesRepo = {
      createInTx: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        LedgerService,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
        {
          provide: LedgerAccountsRepository,
          useValue: mockLedgerAccountsRepo,
        },
        {
          provide: LedgerEntriesRepository,
          useValue: mockLedgerEntriesRepo,
        },
      ],
    }).compile();

    service = module.get<LedgerService>(LedgerService);
    await service.onModuleInit();
  });

  describe("onModuleInit", () => {
    it("should load all ledger accounts into memory via repository", () => {
      expect(mockLedgerAccountsRepo.findAll).toHaveBeenCalled();
    });

    it("should log the number of loaded accounts", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "log");
      await service.onModuleInit();
      expect(logSpy).toHaveBeenCalledWith("Loaded 5 ledger accounts");
      logSpy.mockRestore();
    });

    it("should throw when no accounts found and method is called", async () => {
      mockLedgerAccountsRepo.findAll.mockResolvedValue([]);
      await service.onModuleInit();

      await expect(
        service.recordInvoiceFinalized("inv-1", 10000, "usd", "corr-1"),
      ).rejects.toThrow(BillingException);
    });
  });

  describe("recordInvoiceFinalized", () => {
    it("should create a ledger entry debiting accounts_receivable and crediting revenue", async () => {
      const result = await service.recordInvoiceFinalized(
        "inv-001",
        10050,
        "usd",
        "corr-001",
      );

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          debitAccountId: ACCOUNT_IDS.accounts_receivable,
          creditAccountId: ACCOUNT_IDS.revenue,
          amountCents: 10050,
          currency: "usd",
          referenceType: "invoice",
          referenceId: "inv-001",
          description: "Invoice finalized",
          correlationId: "corr-001",
        }),
        txMock,
      );
    });

    it("should propagate correlation_id to the entry", async () => {
      await service.recordInvoiceFinalized("inv-002", 5000, "usd", "trace-123");

      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: "trace-123",
        }),
        txMock,
      );
    });

    it("should log structured output after creating entry", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "log");

      await service.recordInvoiceFinalized("inv-003", 7500, "usd", "corr-003");

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Ledger entry created",
          debitAccount: "accounts_receivable",
          creditAccount: "revenue",
          amount: 7500,
          referenceType: "invoice",
          referenceId: "inv-003",
          correlationId: "corr-003",
        }),
      );
      logSpy.mockRestore();
    });
  });

  describe("recordPaymentSucceeded", () => {
    it("should create a ledger entry debiting cash and crediting accounts_receivable", async () => {
      const result = await service.recordPaymentSucceeded(
        "pay-001",
        10050,
        "usd",
        "corr-001",
      );

      expect(result).toBeDefined();
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          debitAccountId: ACCOUNT_IDS.cash,
          creditAccountId: ACCOUNT_IDS.accounts_receivable,
          amountCents: 10050,
          currency: "usd",
          referenceType: "payment",
          referenceId: "pay-001",
          description: "Payment succeeded",
          correlationId: "corr-001",
        }),
        txMock,
      );
    });

    it("should log structured output for payment recording", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "log");

      await service.recordPaymentSucceeded("pay-002", 3000, "usd", "corr-002");

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Ledger entry created",
          debitAccount: "cash",
          creditAccount: "accounts_receivable",
          amount: 3000,
          referenceType: "payment",
          referenceId: "pay-002",
          correlationId: "corr-002",
        }),
      );
      logSpy.mockRestore();
    });
  });

  describe("recordCreditNoteIssued", () => {
    it("should create a ledger entry debiting credits and crediting accounts_receivable", async () => {
      const result = await service.recordCreditNoteIssued(
        "cn-001",
        2500,
        "usd",
        "corr-001",
      );

      expect(result).toBeDefined();
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          debitAccountId: ACCOUNT_IDS.credits,
          creditAccountId: ACCOUNT_IDS.accounts_receivable,
          amountCents: 2500,
          currency: "usd",
          referenceType: "credit_note",
          referenceId: "cn-001",
          description: "Credit note issued",
          correlationId: "corr-001",
        }),
        txMock,
      );
    });

    it("should log structured output for credit note recording", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "log");

      await service.recordCreditNoteIssued("cn-002", 1500, "usd", "corr-002");

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Ledger entry created",
          debitAccount: "credits",
          creditAccount: "accounts_receivable",
          amount: 1500,
          referenceType: "credit_note",
          referenceId: "cn-002",
          correlationId: "corr-002",
        }),
      );
      logSpy.mockRestore();
    });
  });

  describe("recordCreditApplied", () => {
    it("should create a ledger entry debiting accounts_receivable and crediting credits", async () => {
      const result = await service.recordCreditApplied(
        "inv-ca-001",
        3000,
        "usd",
        "corr-001",
      );

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          debitAccountId: ACCOUNT_IDS.accounts_receivable,
          creditAccountId: ACCOUNT_IDS.credits,
          amountCents: 3000,
          currency: "usd",
          referenceType: "credit_application",
          referenceId: "inv-ca-001",
          description: "Credit applied to invoice",
          correlationId: "corr-001",
        }),
        txMock,
      );
    });

    it("should use provided transaction context", async () => {
      const externalTx = { some: "tx" };

      const result = await service.recordCreditApplied(
        "inv-ca-002",
        1500,
        "usd",
        "corr-002",
        externalTx as never,
      );

      expect(result).toBeDefined();
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceId: "inv-ca-002",
        }),
        externalTx,
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should log structured output for credit application recording", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "log");

      await service.recordCreditApplied("inv-ca-003", 2500, "usd", "corr-003");

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Ledger entry created",
          debitAccount: "accounts_receivable",
          creditAccount: "credits",
          amount: 2500,
          referenceType: "credit_application",
          referenceId: "inv-ca-003",
          correlationId: "corr-003",
        }),
      );
      logSpy.mockRestore();
    });
  });

  describe("recordInvoiceVoided", () => {
    it("should create a ledger entry debiting revenue and crediting accounts_receivable", async () => {
      const result = await service.recordInvoiceVoided(
        "inv-void-001",
        10050,
        "usd",
        "corr-001",
      );

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          debitAccountId: ACCOUNT_IDS.revenue,
          creditAccountId: ACCOUNT_IDS.accounts_receivable,
          amountCents: 10050,
          currency: "usd",
          referenceType: "invoice_void",
          referenceId: "inv-void-001",
          description: "Invoice voided",
          correlationId: "corr-001",
        }),
        txMock,
      );
    });

    it("should use provided transaction context", async () => {
      const externalTx = { some: "tx" };

      const result = await service.recordInvoiceVoided(
        "inv-void-002",
        5000,
        "usd",
        "corr-002",
        externalTx as never,
      );

      expect(result).toBeDefined();
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceId: "inv-void-002",
        }),
        externalTx,
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should log structured output for invoice void recording", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "log");

      await service.recordInvoiceVoided(
        "inv-void-003",
        7500,
        "usd",
        "corr-003",
      );

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Ledger entry created",
          debitAccount: "revenue",
          creditAccount: "accounts_receivable",
          amount: 7500,
          referenceType: "invoice_void",
          referenceId: "inv-void-003",
          correlationId: "corr-003",
        }),
      );
      logSpy.mockRestore();
    });
  });

  describe("recordRefundSucceeded", () => {
    it("should create a ledger entry debiting refunds and crediting cash", async () => {
      const result = await service.recordRefundSucceeded(
        "ref-001",
        5000,
        "usd",
        "corr-001",
      );

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          debitAccountId: ACCOUNT_IDS.refunds,
          creditAccountId: ACCOUNT_IDS.cash,
          amountCents: 5000,
          currency: "usd",
          referenceType: "refund",
          referenceId: "ref-001",
          description: "Refund succeeded",
          correlationId: "corr-001",
        }),
        txMock,
      );
    });

    it("should use provided transaction context", async () => {
      const externalTx = { some: "tx" };

      const result = await service.recordRefundSucceeded(
        "ref-002",
        3000,
        "usd",
        "corr-002",
        externalTx as never,
      );

      expect(result).toBeDefined();
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceId: "ref-002",
        }),
        externalTx,
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should log structured output for refund recording", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "log");

      await service.recordRefundSucceeded("ref-003", 7500, "usd", "corr-003");

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Ledger entry created",
          debitAccount: "refunds",
          creditAccount: "cash",
          amount: 7500,
          referenceType: "refund",
          referenceId: "ref-003",
          correlationId: "corr-003",
        }),
      );
      logSpy.mockRestore();
    });
  });

  describe("recordMigrationInvoiceFinalized", () => {
    it("should create a migration ledger entry debiting AR and crediting revenue", async () => {
      const result = await service.recordMigrationInvoiceFinalized(
        "inv-mig-001",
        15000,
        "usd",
        42,
        "corr-mig-001",
      );

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          debitAccountId: ACCOUNT_IDS.accounts_receivable,
          creditAccountId: ACCOUNT_IDS.revenue,
          amountCents: 15000,
          currency: "usd",
          referenceType: "migration",
          referenceId: "inv-mig-001",
          description: "Historical migration from monolith charge #42",
          correlationId: "corr-mig-001",
        }),
        txMock,
      );
    });

    it("should use external transaction when provided", async () => {
      const externalTx = { some: "tx" };

      const result = await service.recordMigrationInvoiceFinalized(
        "inv-mig-002",
        5000,
        "usd",
        99,
        "corr-mig-002",
        externalTx as never,
      );

      expect(result).toBeDefined();
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceId: "inv-mig-002",
        }),
        externalTx,
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  describe("recordMigrationPayment", () => {
    it("should create a migration ledger entry debiting cash and crediting AR", async () => {
      const result = await service.recordMigrationPayment(
        "inv-mig-003",
        20000,
        "usd",
        55,
        "corr-mig-003",
      );

      expect(result).toBeDefined();
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          debitAccountId: ACCOUNT_IDS.cash,
          creditAccountId: ACCOUNT_IDS.accounts_receivable,
          amountCents: 20000,
          currency: "usd",
          referenceType: "migration",
          referenceId: "inv-mig-003",
          description: "Historical migration payment from monolith charge #55",
          correlationId: "corr-mig-003",
        }),
        txMock,
      );
    });

    it("should use external transaction when provided", async () => {
      const externalTx = { some: "tx" };

      const result = await service.recordMigrationPayment(
        "inv-mig-004",
        3000,
        "usd",
        77,
        "corr-mig-004",
        externalTx as never,
      );

      expect(result).toBeDefined();
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceId: "inv-mig-004",
        }),
        externalTx,
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  describe("recordMigrationVoidReversal", () => {
    it("should create a migration ledger entry debiting revenue and crediting AR", async () => {
      const result = await service.recordMigrationVoidReversal(
        "inv-mig-005",
        12000,
        "usd",
        88,
        "corr-mig-005",
      );

      expect(result).toBeDefined();
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          debitAccountId: ACCOUNT_IDS.revenue,
          creditAccountId: ACCOUNT_IDS.accounts_receivable,
          amountCents: 12000,
          currency: "usd",
          referenceType: "migration",
          referenceId: "inv-mig-005",
          description:
            "Historical migration void reversal from monolith charge #88",
          correlationId: "corr-mig-005",
        }),
        txMock,
      );
    });

    it("should use external transaction when provided", async () => {
      const externalTx = { some: "tx" };

      const result = await service.recordMigrationVoidReversal(
        "inv-mig-006",
        8000,
        "usd",
        101,
        "corr-mig-006",
        externalTx as never,
      );

      expect(result).toBeDefined();
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceId: "inv-mig-006",
        }),
        externalTx,
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  describe("amount consistency", () => {
    it("should use the same amount_cents for debit and credit in a single entry", async () => {
      await service.recordInvoiceFinalized("inv-100", 99999, "usd", "corr-x");

      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 99999,
          debitAccountId: ACCOUNT_IDS.accounts_receivable,
          creditAccountId: ACCOUNT_IDS.revenue,
        }),
        txMock,
      );
    });
  });

  describe("amount validation", () => {
    it("should reject zero amount", async () => {
      await expect(
        service.recordInvoiceFinalized("inv-zero", 0, "usd", "corr-zero"),
      ).rejects.toThrow(BillingException);

      await expect(
        service.recordInvoiceFinalized("inv-zero", 0, "usd", "corr-zero"),
      ).rejects.toThrow("Ledger entry amount must be positive");
    });

    it("should reject negative amount", async () => {
      await expect(
        service.recordInvoiceFinalized("inv-neg", -500, "usd", "corr-neg"),
      ).rejects.toThrow(BillingException);

      await expect(
        service.recordInvoiceFinalized("inv-neg", -500, "usd", "corr-neg"),
      ).rejects.toThrow("Ledger entry amount must be positive");
    });

    it("should reject negative amount with UNPROCESSABLE_ENTITY status", async () => {
      try {
        await service.recordInvoiceFinalized(
          "inv-neg",
          -100,
          "usd",
          "corr-neg",
        );
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(BillingException);
        expect((error as BillingException).getStatus()).toBe(
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    });

    it("should not call db.transaction when amount is invalid", async () => {
      await expect(
        service.recordInvoiceFinalized("inv-neg", -1, "usd", "corr-neg"),
      ).rejects.toThrow();

      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should throw BillingException when account not found", async () => {
      mockLedgerAccountsRepo.findAll.mockResolvedValue([]);
      await service.onModuleInit();

      await expect(
        service.recordInvoiceFinalized("inv-err", 1000, "usd", "corr-err"),
      ).rejects.toThrow(BillingException);

      await expect(
        service.recordInvoiceFinalized("inv-err", 1000, "usd", "corr-err"),
      ).rejects.toThrow("Ledger account not found");
    });

    it("should throw with INTERNAL_SERVER_ERROR status when account not found", async () => {
      mockLedgerAccountsRepo.findAll.mockResolvedValue([]);
      await service.onModuleInit();

      try {
        await service.recordInvoiceFinalized(
          "inv-err",
          1000,
          "usd",
          "corr-err",
        );
        fail("Expected BillingException");
      } catch (error) {
        expect(error).toBeInstanceOf(BillingException);
        expect((error as BillingException).getStatus()).toBe(
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    });

    it("should roll back transaction on insert failure", async () => {
      mockLedgerEntriesRepo.createInTx.mockRejectedValueOnce(
        new Error("DB insert failed"),
      );

      await expect(
        service.recordInvoiceFinalized("inv-fail", 1000, "usd", "corr-fail"),
      ).rejects.toThrow("DB insert failed");
    });
  });

  describe("external transaction support", () => {
    it("should use external transaction when provided", async () => {
      const externalTx = { some: "tx" };

      const result = await service.recordInvoiceFinalized(
        "inv-ext",
        5000,
        "usd",
        "corr-ext",
        externalTx as never,
      );

      expect(result).toBeDefined();
      expect(mockLedgerEntriesRepo.createInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceId: "inv-ext",
        }),
        externalTx,
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should not create a new transaction when external tx is provided", async () => {
      const externalTx = { some: "tx" };

      await service.recordPaymentSucceeded(
        "pay-ext",
        3000,
        "usd",
        "corr-ext",
        externalTx as never,
      );

      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });
});
