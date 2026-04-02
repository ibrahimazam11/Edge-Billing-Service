import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import {
  ChargesMigrationService,
  dollarsToCents,
  mapPaymentStatus,
} from "./charges-migration.service";
import type {
  MonolithCustomerCharge,
  MonolithOneTimeChargeLineItem,
} from "./charges-migration.service";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import { CustomersRepository } from "../customers/customers.repository";
import { PaymentMethodsRepository } from "../payment-methods/payment-methods.repository";
import { InvoicesRepository } from "../invoices/invoices.repository";
import { LedgerService } from "../ledger/ledger.service";
import { MigrationLogsRepository } from "./migration-logs.repository";
import { MONOLITH_DB_PROVIDER } from "./monolith-database.provider";

// --- Mock setup ---

const CUSTOMER_ID = "c0000000-0000-4000-a000-000000000001";
const MONOLITH_CUSTOMER_ID = "CUST-001";
const PAYMENT_METHOD_ID = "pm-0000-0000-4000-a000-000000000001";
const RUN_ID = "run-0000-0000-4000-a000-000000000001";
const SCRIPT_NAME = "migrate-customer-charges";

function makeCharge(
  overrides: Partial<MonolithCustomerCharge> = {},
): MonolithCustomerCharge {
  return {
    Charge_ID: 1,
    Customer_ID: MONOLITH_CUSTOMER_ID,
    Amount: "150.00",
    Charge_Type: "one_time",
    Payment_Status: "paid",
    Payment_Date: new Date("2025-06-15"),
    Failure_Reason: null,
    Scheduled_At: new Date("2025-06-15"),
    Credit_Card_Surcharge: null,
    Starting_Balance: null,
    Invoice_ID: null,
    deletedAt: null,
    createdAt: new Date("2025-06-01"),
    ...overrides,
  };
}

function makeLineItem(
  overrides: Partial<MonolithOneTimeChargeLineItem> = {},
): MonolithOneTimeChargeLineItem {
  return {
    id: 1,
    Charge_ID: 1,
    Fee: "150.00",
    Implementation_Fee: "50.00",
    Discount: "25.00",
    Total: "175.00",
    Employee_Name: "John Doe",
    Notes: "Setup fee",
    Type: "onboarding",
    ...overrides,
  };
}

describe("ChargesMigrationService", () => {
  let service: ChargesMigrationService;

  // Drizzle mock — transaction only (selects go through repos)
  let txInsertValues: jest.Mock;
  let txInsertChain: { values: jest.Mock };
  let txMock: { insert: jest.Mock };
  let mockDb: { transaction: jest.Mock };

  let mockMonolithPool: { query: jest.Mock };

  let mockCustomersRepo: {
    findAllForMigration: jest.Mock;
    findByMonolithId: jest.Mock;
  };
  let mockPaymentMethodsRepo: {
    getDefaultPaymentMethod: jest.Mock;
    findAllByCustomerUnfiltered: jest.Mock;
  };
  let mockInvoicesRepo: { findByMonolithMetadata: jest.Mock };

  let mockLedgerService: {
    recordMigrationInvoiceFinalized: jest.Mock;
    recordMigrationPayment: jest.Mock;
    recordMigrationVoidReversal: jest.Mock;
  };

  let mockMigrationLogsRepo: { createLog: jest.Mock };

  beforeEach(async () => {
    jest.restoreAllMocks();

    txInsertValues = jest.fn().mockResolvedValue(undefined);
    txInsertChain = { values: txInsertValues };
    txMock = { insert: jest.fn().mockReturnValue(txInsertChain) };
    mockDb = {
      transaction: jest.fn((cb: (tx: typeof txMock) => Promise<void>) =>
        cb(txMock),
      ),
    };

    mockMonolithPool = { query: jest.fn() };

    mockCustomersRepo = {
      findAllForMigration: jest.fn().mockResolvedValue([]),
      findByMonolithId: jest.fn().mockResolvedValue(null),
    };
    mockPaymentMethodsRepo = {
      getDefaultPaymentMethod: jest.fn().mockResolvedValue(null),
      findAllByCustomerUnfiltered: jest.fn().mockResolvedValue([]),
    };
    mockInvoicesRepo = {
      findByMonolithMetadata: jest.fn().mockResolvedValue(null),
    };

    mockLedgerService = {
      recordMigrationInvoiceFinalized: jest.fn().mockResolvedValue("ledger-1"),
      recordMigrationPayment: jest.fn().mockResolvedValue("ledger-2"),
      recordMigrationVoidReversal: jest.fn().mockResolvedValue("ledger-3"),
    };

    mockMigrationLogsRepo = {
      createLog: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const module = await Test.createTestingModule({
      providers: [
        ChargesMigrationService,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
        { provide: MONOLITH_DB_PROVIDER, useValue: mockMonolithPool },
        { provide: CustomersRepository, useValue: mockCustomersRepo },
        {
          provide: PaymentMethodsRepository,
          useValue: mockPaymentMethodsRepo,
        },
        { provide: InvoicesRepository, useValue: mockInvoicesRepo },
        { provide: LedgerService, useValue: mockLedgerService },
        {
          provide: MigrationLogsRepository,
          useValue: mockMigrationLogsRepo,
        },
      ],
    }).compile();

    service = module.get<ChargesMigrationService>(ChargesMigrationService);
  });

  // --- dollarsToCents utility tests (AC2) ---

  describe("dollarsToCents", () => {
    it("should convert dollars to cents", () => {
      expect(dollarsToCents(10.5)).toBe(1050);
      expect(dollarsToCents("150.00")).toBe(15000);
      expect(dollarsToCents("10.10")).toBe(1010);
    });

    it("should return null for null/undefined", () => {
      expect(dollarsToCents(null)).toBeNull();
      expect(dollarsToCents(undefined)).toBeNull();
    });

    it("should return null for NaN strings", () => {
      expect(dollarsToCents("abc")).toBeNull();
    });

    it("should handle negative amounts (discounts)", () => {
      expect(dollarsToCents(-25.0)).toBe(-2500);
      expect(dollarsToCents("-25.00")).toBe(-2500);
    });

    it("should handle zero", () => {
      expect(dollarsToCents(0)).toBe(0);
      expect(dollarsToCents("0.00")).toBe(0);
    });
  });

  // --- mapPaymentStatus tests (AC4) ---

  describe("mapPaymentStatus", () => {
    it('should map "paid" to paid invoice with succeeded charge', () => {
      expect(mapPaymentStatus("paid")).toEqual({
        invoiceStatus: "paid",
        createCharge: true,
        chargeStatus: "succeeded",
      });
    });

    it('should map "succeeded" to paid invoice with succeeded charge', () => {
      expect(mapPaymentStatus("succeeded")).toEqual({
        invoiceStatus: "paid",
        createCharge: true,
        chargeStatus: "succeeded",
      });
    });

    it('should map "failed" to finalized invoice with failed charge', () => {
      expect(mapPaymentStatus("failed")).toEqual({
        invoiceStatus: "finalized",
        createCharge: true,
        chargeStatus: "failed",
      });
    });

    it('should map "pending" to finalized invoice with pending charge', () => {
      expect(mapPaymentStatus("pending")).toEqual({
        invoiceStatus: "finalized",
        createCharge: true,
        chargeStatus: "pending",
      });
    });

    it('should map "processing" to finalized invoice with pending charge', () => {
      expect(mapPaymentStatus("processing")).toEqual({
        invoiceStatus: "finalized",
        createCharge: true,
        chargeStatus: "pending",
      });
    });

    it('should map "voided" to void invoice with no charge', () => {
      expect(mapPaymentStatus("voided")).toEqual({
        invoiceStatus: "void",
        createCharge: false,
      });
    });

    it('should map "refunded" to void invoice with no charge', () => {
      expect(mapPaymentStatus("refunded")).toEqual({
        invoiceStatus: "void",
        createCharge: false,
      });
    });

    it("should return null for unknown status", () => {
      expect(mapPaymentStatus("weird_status")).toBeNull();
    });

    it("should handle case-insensitive matching", () => {
      expect(mapPaymentStatus("PAID")).toEqual({
        invoiceStatus: "paid",
        createCharge: true,
        chargeStatus: "succeeded",
      });
    });

    it("should handle whitespace-padded status", () => {
      expect(mapPaymentStatus("  paid  ")).toEqual({
        invoiceStatus: "paid",
        createCharge: true,
        chargeStatus: "succeeded",
      });
    });

    it("should return null for null status", () => {
      expect(mapPaymentStatus(null)).toBeNull();
    });
  });

  // --- migrateSingleCharge tests ---

  describe("migrateSingleCharge — happy path: paid charge with line items", () => {
    it("should create invoice + charge + line items + 2 ledger pairs", async () => {
      const charge = makeCharge({ Charge_ID: 10, Amount: "175.00" });
      const lineItems = [makeLineItem({ Charge_ID: 10 })];

      // Idempotency check: no existing invoice
      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSingleCharge(
        charge,
        lineItems,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        PAYMENT_METHOD_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.lineItemCount).toBe(3); // fee + impl_fee + discount
      expect(result.ledgerPairCount).toBe(2); // finalize + payment

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);

      expect(
        mockLedgerService.recordMigrationInvoiceFinalized,
      ).toHaveBeenCalledWith(
        expect.any(String),
        17500,
        "usd",
        10,
        expect.stringContaining("migration-"),
        txMock,
      );
      expect(mockLedgerService.recordMigrationPayment).toHaveBeenCalledWith(
        expect.any(String),
        17500,
        "usd",
        10,
        expect.stringContaining("migration-"),
        txMock,
      );
    });
  });

  describe("migrateSingleCharge — happy path: failed charge", () => {
    it("should create invoice + charge + 1 ledger pair (no payment)", async () => {
      const charge = makeCharge({
        Charge_ID: 20,
        Amount: "100.00",
        Payment_Status: "failed",
        Failure_Reason: "Card declined",
        Payment_Date: null,
      });

      // Idempotency check: no existing invoice
      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSingleCharge(
        charge,
        [],
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        PAYMENT_METHOD_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.lineItemCount).toBe(1); // single base_fee (no line items)
      expect(result.ledgerPairCount).toBe(1); // finalize only

      expect(
        mockLedgerService.recordMigrationInvoiceFinalized,
      ).toHaveBeenCalledTimes(1);
      expect(mockLedgerService.recordMigrationPayment).not.toHaveBeenCalled();
    });
  });

  describe("migrateSingleCharge — happy path: voided charge", () => {
    it("should create invoice (void) + 2 ledger pairs (finalize + reverse), no charge", async () => {
      const charge = makeCharge({
        Charge_ID: 30,
        Amount: "200.00",
        Payment_Status: "voided",
        Payment_Date: null,
      });

      // Idempotency check
      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSingleCharge(
        charge,
        [],
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        PAYMENT_METHOD_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.ledgerPairCount).toBe(2); // finalize + reversal

      expect(
        mockLedgerService.recordMigrationInvoiceFinalized,
      ).toHaveBeenCalledTimes(1);
      expect(
        mockLedgerService.recordMigrationVoidReversal,
      ).toHaveBeenCalledTimes(1);
      expect(mockLedgerService.recordMigrationPayment).not.toHaveBeenCalled();
    });
  });

  describe("migrateSingleCharge — charge without line items (AC6)", () => {
    it("should create single base_fee line item from charge Amount", async () => {
      const charge = makeCharge({ Charge_ID: 40, Amount: "200.00" });

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSingleCharge(
        charge,
        [],
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        PAYMENT_METHOD_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.lineItemCount).toBe(1);
    });
  });

  describe("migrateSingleCharge — soft-deleted charge (AC3)", () => {
    it("should skip charge with deletedAt set", async () => {
      const charge = makeCharge({
        Charge_ID: 45,
        deletedAt: new Date("2025-07-01"),
      });

      const result = await service.migrateSingleCharge(
        charge,
        [],
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        PAYMENT_METHOD_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("soft_deleted");
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  describe("migrateSingleCharge — null amount (AC2)", () => {
    it("should skip charge with null amount", async () => {
      const charge = makeCharge({ Charge_ID: 50, Amount: null });

      const result = await service.migrateSingleCharge(
        charge,
        [],
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        PAYMENT_METHOD_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("null_amount");
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  describe("migrateSingleCharge — unknown payment status (AC4)", () => {
    it("should skip charge with unknown status", async () => {
      const charge = makeCharge({
        Charge_ID: 60,
        Payment_Status: "weird_status",
      });

      const warnSpy = jest.spyOn(Logger.prototype, "warn");

      const result = await service.migrateSingleCharge(
        charge,
        [],
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        PAYMENT_METHOD_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("unknown_payment_status");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "migration.charges.unknown_status",
          chargeId: 60,
          originalStatus: "weird_status",
        }),
      );
    });
  });

  describe("migrateSingleCharge — already migrated (AC8)", () => {
    it("should skip charge that was already migrated (idempotency)", async () => {
      const charge = makeCharge({ Charge_ID: 70 });

      // Idempotency check: existing invoice found
      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce({
        id: "existing-invoice-id",
      });

      const result = await service.migrateSingleCharge(
        charge,
        [],
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        PAYMENT_METHOD_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("already_migrated");
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  describe("migrateSingleCharge — no payment method", () => {
    it("should fail charge when no payment method and charge needed", async () => {
      const charge = makeCharge({ Charge_ID: 80 });

      // Idempotency check: no existing
      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSingleCharge(
        charge,
        [],
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        null, // no payment method
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("failed");
      expect(result.reason).toBe("no_payment_method");
    });
  });

  describe("migrateSingleCharge — voided charge without payment method", () => {
    it("should succeed for voided charge even without PM", async () => {
      const charge = makeCharge({
        Charge_ID: 81,
        Payment_Status: "voided",
        Amount: "100.00",
      });

      // Idempotency check
      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSingleCharge(
        charge,
        [],
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        null,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.ledgerPairCount).toBe(2);
    });
  });

  describe("migrateSingleCharge — dry-run mode (AC9)", () => {
    it("should validate without DB writes", async () => {
      const charge = makeCharge({ Charge_ID: 90, Amount: "250.00" });
      const lineItems = [makeLineItem({ Charge_ID: 90 })];

      // Idempotency check
      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSingleCharge(
        charge,
        lineItems,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        PAYMENT_METHOD_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: true, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.reason).toBe("dry_run");
      expect(result.lineItemCount).toBe(3);
      expect(result.ledgerPairCount).toBe(2);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  describe("migrateSingleCharge — credit card surcharge (AC1, AC5)", () => {
    it("should create separate surcharge line item", async () => {
      const charge = makeCharge({
        Charge_ID: 100,
        Amount: "175.00",
        Credit_Card_Surcharge: "5.25",
      });
      const lineItems = [makeLineItem({ Charge_ID: 100 })];

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSingleCharge(
        charge,
        lineItems,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        PAYMENT_METHOD_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.lineItemCount).toBe(4); // fee + impl_fee + discount + surcharge
    });
  });

  describe("migrateSingleCharge — line item total mismatch (AC2)", () => {
    it("should warn but still migrate when totals mismatch", async () => {
      const charge = makeCharge({ Charge_ID: 110, Amount: "200.00" });
      const lineItems = [
        makeLineItem({
          Charge_ID: 110,
          Fee: "100.00",
          Implementation_Fee: "50.00",
          Discount: "10.00",
          Total: "150.00", // 14000 != 15000 → mismatch > 1 cent
        }),
      ];

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const warnSpy = jest.spyOn(Logger.prototype, "warn");

      const result = await service.migrateSingleCharge(
        charge,
        lineItems,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        PAYMENT_METHOD_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.conversionWarnings).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "migration.charges.line_item_total_mismatch",
          chargeId: 110,
          lineItemType: "onboarding",
        }),
      );
    });
  });

  describe("migrateSingleCharge — error resilience", () => {
    it("should catch transaction errors and return failed result", async () => {
      const charge = makeCharge({ Charge_ID: 120 });

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);
      mockDb.transaction.mockRejectedValueOnce(new Error("DB connection lost"));

      const result = await service.migrateSingleCharge(
        charge,
        [],
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        PAYMENT_METHOD_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("failed");
      expect(result.reason).toBe("DB connection lost");
    });

    it("should handle migration log write failure in catch block", async () => {
      const charge = makeCharge({ Charge_ID: 121 });

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);
      mockDb.transaction.mockRejectedValueOnce(new Error("TX error"));
      mockMigrationLogsRepo.createLog.mockRejectedValueOnce(
        new Error("Log write failed"),
      );

      const errorSpy = jest.spyOn(Logger.prototype, "error");

      const result = await service.migrateSingleCharge(
        charge,
        [],
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        PAYMENT_METHOD_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("failed");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "migration.charges.log_write_failed",
        }),
      );
    });
  });

  // --- Monolith query helper tests ---

  describe("fetchChargesForCustomer", () => {
    it("should query monolith DB with correct SQL", async () => {
      mockMonolithPool.query.mockResolvedValueOnce({
        rows: [makeCharge()],
      });

      const result =
        await service.fetchChargesForCustomer(MONOLITH_CUSTOMER_ID);

      expect(result).toHaveLength(1);
      expect(mockMonolithPool.query).toHaveBeenCalledWith(
        expect.stringContaining("Customer_Charge"),
        [MONOLITH_CUSTOMER_ID],
      );
    });
  });

  describe("fetchLineItemsForCharge", () => {
    it("should query monolith DB for line items by charge ID", async () => {
      mockMonolithPool.query.mockResolvedValueOnce({
        rows: [makeLineItem()],
      });

      const result = await service.fetchLineItemsForCharge(1);

      expect(result).toHaveLength(1);
      expect(mockMonolithPool.query).toHaveBeenCalledWith(
        expect.stringContaining("One_Time_Charge_Invoice_Items"),
        [1],
      );
    });
  });

  // --- migrateAll / migrateByIds tests ---

  describe("migrateAll", () => {
    it("should throw if monolith pool not configured", async () => {
      const module = await Test.createTestingModule({
        providers: [
          ChargesMigrationService,
          { provide: DRIZZLE_PROVIDER, useValue: mockDb },
          { provide: MONOLITH_DB_PROVIDER, useValue: null },
          { provide: CustomersRepository, useValue: mockCustomersRepo },
          {
            provide: PaymentMethodsRepository,
            useValue: mockPaymentMethodsRepo,
          },
          { provide: InvoicesRepository, useValue: mockInvoicesRepo },
          { provide: LedgerService, useValue: mockLedgerService },
          {
            provide: MigrationLogsRepository,
            useValue: mockMigrationLogsRepo,
          },
        ],
      }).compile();

      const svc = module.get<ChargesMigrationService>(ChargesMigrationService);

      await expect(
        svc.migrateAll({ dryRun: false, batchSize: 50, batchDelayMs: 0 }),
      ).rejects.toThrow("Monolith database connection is not configured");
    });

    it("should process batches and return summary", async () => {
      // migratedCustomers
      mockCustomersRepo.findAllForMigration.mockResolvedValueOnce([
        { id: CUSTOMER_ID, monolithCustomerId: MONOLITH_CUSTOMER_ID },
      ]);

      // fetchChargesForCustomer -> 0 charges
      mockMonolithPool.query.mockResolvedValueOnce({ rows: [] });

      // PM lookup in migrateChargesForCustomer
      mockPaymentMethodsRepo.getDefaultPaymentMethod.mockResolvedValueOnce({
        id: PAYMENT_METHOD_ID,
      });

      const summary = await service.migrateAll({
        dryRun: false,
        batchSize: 50,
        batchDelayMs: 0,
      });

      expect(summary.runId).toBeDefined();
      expect(summary.totalCharges).toBe(0);
    });
  });

  describe("migrateByIds", () => {
    it("should look up customers by monolith IDs and process", async () => {
      // Customer lookup
      mockCustomersRepo.findByMonolithId.mockResolvedValueOnce({
        id: CUSTOMER_ID,
        monolithCustomerId: MONOLITH_CUSTOMER_ID,
      });

      // fetchChargesForCustomer
      mockMonolithPool.query.mockResolvedValueOnce({ rows: [] });

      // PM lookup
      mockPaymentMethodsRepo.getDefaultPaymentMethod.mockResolvedValueOnce({
        id: PAYMENT_METHOD_ID,
      });

      const summary = await service.migrateByIds([MONOLITH_CUSTOMER_ID], {
        dryRun: false,
        batchSize: 50,
        batchDelayMs: 0,
      });

      expect(summary.totalCharges).toBe(0);
    });

    it("should warn when customer not found by monolith ID", async () => {
      // Customer lookup returns null (default mock behavior)

      const warnSpy = jest.spyOn(Logger.prototype, "warn");

      const summary = await service.migrateByIds(["NONEXISTENT"], {
        dryRun: false,
        batchSize: 50,
        batchDelayMs: 0,
      });

      expect(summary.totalCharges).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "migration.charges.customer_not_found",
        }),
      );
    });
  });
});
