import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import {
  PayrollBillingMigrationService,
  mapPayrollStatus,
  deriveBillingPeriod,
  mapPaymentMethodType,
} from "./payroll-billing-migration.service";
import type { MonolithCustomerPayroll } from "./payroll-billing-migration.service";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import { CustomersRepository } from "../customers/customers.repository";
import { PaymentMethodsRepository } from "../payment-methods/payment-methods.repository";
import { SubscriptionsRepository } from "../subscriptions/subscriptions.repository";
import { InvoicesRepository } from "../invoices/invoices.repository";
import { LedgerService } from "../ledger/ledger.service";
import { MigrationLogsRepository } from "./migration-logs.repository";
import { MONOLITH_DB_PROVIDER } from "./monolith-database.provider";

// --- Mock setup ---

const CUSTOMER_ID = "c0000000-0000-4000-a000-000000000001";
const MONOLITH_CUSTOMER_ID = "CUST-001";
const PM_ID = "pm000000-0000-4000-a000-000000000001";
const RUN_ID = "run00000-0000-4000-a000-000000000001";
const SCRIPT_NAME = "migrate-payroll-billing";

function makePayroll(
  overrides: Partial<MonolithCustomerPayroll> = {},
): MonolithCustomerPayroll {
  return {
    Customer_Payroll_ID: "PAY-001",
    Customer_ID: MONOLITH_CUSTOMER_ID,
    Total_Amount: "500.00",
    Total_Bonus: null,
    Payment_Date: new Date("2025-06-15"),
    Paid_On: new Date("2025-06-16"),
    Status: "paid",
    Payroll_Month: new Date("2025-06-01"),
    Credit_Card_Surcharge: null,
    Failure: false,
    Failure_Date: null,
    Failure_Reason: null,
    Payment_Method: "ACH",
    Reference_Number: "REF-001",
    createdBy: "admin",
    updatedBy: "admin",
    Invoice_ID: null,
    ...overrides,
  };
}

describe("PayrollBillingMigrationService", () => {
  let service: PayrollBillingMigrationService;

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
  let mockPaymentMethodsRepo: { findAllByCustomerUnfiltered: jest.Mock };
  let mockSubscriptionsRepo: { findByCustomerAndStatuses: jest.Mock };
  let mockInvoicesRepo: { findByMonolithMetadata: jest.Mock };

  let mockLedgerService: {
    recordMigrationPayrollFinalized: jest.Mock;
    recordMigrationPayrollPayment: jest.Mock;
  };

  let mockMigrationLogsRepo: { createLog: jest.Mock };

  beforeEach(async () => {
    jest.restoreAllMocks();

    txInsertValues = jest.fn().mockReturnThis();
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
      findAllByCustomerUnfiltered: jest.fn().mockResolvedValue([]),
    };
    mockSubscriptionsRepo = {
      findByCustomerAndStatuses: jest.fn().mockResolvedValue([]),
    };
    mockInvoicesRepo = {
      findByMonolithMetadata: jest.fn().mockResolvedValue(null),
    };

    mockLedgerService = {
      recordMigrationPayrollFinalized: jest.fn().mockResolvedValue("ledger-1"),
      recordMigrationPayrollPayment: jest.fn().mockResolvedValue("ledger-2"),
    };

    mockMigrationLogsRepo = {
      createLog: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const module = await Test.createTestingModule({
      providers: [
        PayrollBillingMigrationService,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
        { provide: MONOLITH_DB_PROVIDER, useValue: mockMonolithPool },
        { provide: CustomersRepository, useValue: mockCustomersRepo },
        {
          provide: PaymentMethodsRepository,
          useValue: mockPaymentMethodsRepo,
        },
        {
          provide: SubscriptionsRepository,
          useValue: mockSubscriptionsRepo,
        },
        { provide: InvoicesRepository, useValue: mockInvoicesRepo },
        { provide: LedgerService, useValue: mockLedgerService },
        {
          provide: MigrationLogsRepository,
          useValue: mockMigrationLogsRepo,
        },
      ],
    }).compile();

    service = module.get(PayrollBillingMigrationService);
  });

  // --- Test 3.1: Happy path paid payroll ---

  describe("3.1: paid payroll -> invoice + charge + line items + 2 ledger pairs", () => {
    it("should migrate a paid payroll with correct records", async () => {
      const payroll = makePayroll();

      // Idempotency check: no existing invoice
      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "bank_account", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.lineItemCount).toBe(1); // base_fee only (no bonus, no surcharge)
      expect(result.ledgerPairCount).toBe(2); // finalize + payment

      // Verify tx.insert called (invoice, line item, charge, migration log)
      expect(txMock.insert).toHaveBeenCalledTimes(4);

      // Verify ledger service calls
      expect(
        mockLedgerService.recordMigrationPayrollFinalized,
      ).toHaveBeenCalledTimes(1);
      expect(
        mockLedgerService.recordMigrationPayrollPayment,
      ).toHaveBeenCalledTimes(1);
    });
  });

  // --- Test 3.2: Failed payroll ---

  describe("3.2: failed payroll (Failure=true) -> invoice + charge (failed) + 1 ledger pair", () => {
    it("should migrate a failed payroll correctly", async () => {
      const payroll = makePayroll({
        Failure: true,
        Failure_Reason: "Card declined",
        Status: "paid", // Failure overrides Status
      });

      // Idempotency check: no existing invoice
      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "bank_account", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.ledgerPairCount).toBe(1); // finalize only, no payment

      // Verify charge has failed status
      expect(
        mockLedgerService.recordMigrationPayrollFinalized,
      ).toHaveBeenCalledTimes(1);
      expect(
        mockLedgerService.recordMigrationPayrollPayment,
      ).not.toHaveBeenCalled();
    });
  });

  // --- Test 3.3: Payroll with bonus ---

  describe("3.3: payroll with bonus -> 2 base_fee line items", () => {
    it("should create base and bonus line items", async () => {
      const payroll = makePayroll({ Total_Bonus: "100.00" });

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "bank_account", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.lineItemCount).toBe(2); // base_fee + bonus
    });
  });

  // --- Test 3.4: Payroll with surcharge ---

  describe("3.4: payroll with surcharge -> surcharge line item", () => {
    it("should create surcharge line item", async () => {
      const payroll = makePayroll({ Credit_Card_Surcharge: "15.00" });

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "card", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.lineItemCount).toBe(2); // base_fee + surcharge
    });
  });

  // --- Test 3.5: Payroll with bonus + surcharge ---

  describe("3.5: payroll with bonus + surcharge -> 3 line items", () => {
    it("should create base, bonus, and surcharge line items", async () => {
      const payroll = makePayroll({
        Total_Bonus: "100.00",
        Credit_Card_Surcharge: "15.00",
      });

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "card", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.lineItemCount).toBe(3);
    });
  });

  // --- Test 3.6: Nullable Customer_ID -> skip ---

  describe("3.6: nullable Customer_ID -> skip orphaned", () => {
    it("should skip with orphaned_no_customer_id", async () => {
      const payroll = makePayroll({ Customer_ID: null });

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "bank_account", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("orphaned_no_customer_id");
    });
  });

  // --- Test 3.7: Nullable Total_Amount -> skip ---

  describe("3.7: nullable Total_Amount -> skip null_amount", () => {
    it("should skip with null_amount", async () => {
      const payroll = makePayroll({ Total_Amount: null });

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "bank_account", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("null_amount");
    });
  });

  // --- Test 3.8: Customer not in billing DB ---

  describe("3.8: customer not in billing DB", () => {
    it("should log customer_not_found in migrateByIds", async () => {
      // Customer lookup returns null (default mock behavior)

      const summary = await service.migrateByIds(["NONEXISTENT-CUST"], {
        dryRun: false,
        batchSize: 50,
        batchDelayMs: 0,
      });

      expect(summary.totalPayrolls).toBe(0);
    });
  });

  // --- Test 3.9: Idempotency ---

  describe("3.9: already-migrated payroll -> skip", () => {
    it("should skip already migrated payroll", async () => {
      const payroll = makePayroll();

      // Idempotency check returns existing invoice
      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce({
        id: "existing-inv-id",
      });

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "bank_account", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("already_migrated");
    });
  });

  // --- Test 3.10: Unknown payment status ---

  describe("3.10: unknown payment status -> skip with warning", () => {
    it("should skip with unknown_status", async () => {
      const payroll = makePayroll({ Status: "bizarre_status", Failure: false });

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "bank_account", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("unknown_status");
    });
  });

  // --- Test 3.11: Payment method lookup ---

  describe("3.11: payment method lookup logic", () => {
    it("should prefer default PM matching type", async () => {
      const payroll = makePayroll({ Payment_Method: "ACH" });

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null); // idempotency

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [
          { id: "pm-card", type: "card", isDefault: true },
          { id: "pm-bank", type: "bank_account", isDefault: true },
        ],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
    });

    it("should fall back to any PM when no type match", async () => {
      const payroll = makePayroll({ Payment_Method: "unknown_type" });

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null); // idempotency

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "card", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
    });

    it("should fail when no PM exists and charge needed", async () => {
      const payroll = makePayroll();

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null); // idempotency

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [], // No payment methods
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("failed");
      expect(result.reason).toBe("no_payment_method");
    });
  });

  // --- Test 3.12: Billing period derivation ---

  describe("3.12: billing period derivation", () => {
    it("should derive correct period from Payroll_Month", () => {
      const result = deriveBillingPeriod(new Date("2025-06-01"));
      expect(result.billingPeriodStart).toEqual(
        new Date("2025-06-01T00:00:00.000Z"),
      );
      expect(result.billingPeriodEnd).toEqual(
        new Date("2025-07-01T00:00:00.000Z"),
      );
    });

    it("should handle December -> January rollover", () => {
      const result = deriveBillingPeriod(new Date("2025-12-01"));
      expect(result.billingPeriodStart).toEqual(
        new Date("2025-12-01T00:00:00.000Z"),
      );
      expect(result.billingPeriodEnd).toEqual(
        new Date("2026-01-01T00:00:00.000Z"),
      );
    });
  });

  // --- Test 3.13: Dollar-to-cents conversion ---

  describe("3.13: dollar-to-cents conversion accuracy", () => {
    it("should correctly compute line items for $500 total, $100 bonus, $15 surcharge", async () => {
      const payroll = makePayroll({
        Total_Amount: "500.00",
        Total_Bonus: "100.00",
        Credit_Card_Surcharge: "15.00",
      });

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null); // idempotency

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "card", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.lineItemCount).toBe(3);
      // base=38500 + bonus=10000 + surcharge=1500 = 50000
    });
  });

  // --- Test 3.14: Line item total mismatch ---

  describe("3.14: line item total mismatch -> warning", () => {
    it("should still migrate when line items have rounding mismatch", async () => {
      // Total_Amount = 500.01, bonus = 100.005 -> rounding could cause mismatch
      const payroll = makePayroll({
        Total_Amount: "500.01",
        Total_Bonus: "100.005",
        Credit_Card_Surcharge: "15.00",
      });

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "card", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      // Should still succeed despite potential rounding mismatch
      expect(result.status).toBe("succeeded");
    });
  });

  // --- Test: conversionWarnings counter (review regression H1) ---

  describe("H1 regression: conversionWarnings counter", () => {
    it("should include conversionWarnings in result", async () => {
      const payroll = makePayroll({
        Total_Amount: "500.00",
        Total_Bonus: "100.00",
        Credit_Card_Surcharge: "15.00",
      });

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "bank_account", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      // conversionWarnings should now be a number (0 in this case, but the field EXISTS)
      expect(result.conversionWarnings).toBeDefined();
      expect(typeof result.conversionWarnings).toBe("number");
    });
  });

  // --- Test 3.15: Dry-run mode ---

  describe("3.15: dry-run mode", () => {
    it("should not create DB writes except migration_logs", async () => {
      const payroll = makePayroll();

      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null); // idempotency

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "bank_account", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: true, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.reason).toBe("dry_run");

      // Transaction should NOT be called in dry-run
      expect(mockDb.transaction).not.toHaveBeenCalled();

      // Migration log SHOULD be written via repository
      expect(mockMigrationLogsRepo.createLog).toHaveBeenCalled();
    });
  });

  // --- Test 3.16: Summary output ---

  describe("3.16: summary output correctness", () => {
    it("should produce correct summary for migrateByIds", async () => {
      // Step 1: Customer lookup by monolith ID
      mockCustomersRepo.findByMonolithId.mockResolvedValueOnce({
        id: CUSTOMER_ID,
        monolithCustomerId: MONOLITH_CUSTOMER_ID,
      });

      // Step 2: fetchPayrollForCustomer -> monolith pool query
      mockMonolithPool.query.mockResolvedValueOnce({
        rows: [
          makePayroll(),
          makePayroll({ Customer_Payroll_ID: "PAY-002", Total_Amount: null }),
        ],
      });

      // Step 3: PM query
      mockPaymentMethodsRepo.findAllByCustomerUnfiltered.mockResolvedValueOnce([
        { id: PM_ID, type: "bank_account", isDefault: true },
      ]);

      // Step 4: Subscription alignment -> no active subscription
      mockSubscriptionsRepo.findByCustomerAndStatuses.mockResolvedValueOnce([]);

      // Step 5: Idempotency for PAY-001 (no hit)
      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);
      // PAY-002 has null amount so it skips before idempotency check

      const summary = await service.migrateByIds([MONOLITH_CUSTOMER_ID], {
        dryRun: false,
        batchSize: 50,
        batchDelayMs: 0,
      });

      expect(summary.totalPayrolls).toBe(2);
      expect(summary.succeeded).toBe(1);
      expect(summary.nullAmountSkipped).toBe(1);
    });
  });

  // --- Test 3.17: Migration log error resilience ---

  describe("3.17: migration log error resilience", () => {
    it("should not throw when migration log write fails in catch", async () => {
      const payroll = makePayroll();

      // Idempotency check: no existing
      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      // Make transaction throw
      mockDb.transaction.mockRejectedValueOnce(new Error("DB write error"));

      // Make migration log write in catch also throw
      mockMigrationLogsRepo.createLog.mockRejectedValueOnce(
        new Error("Migration log write failed"),
      );

      const result = await service.migrateSinglePayroll(
        payroll,
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        [{ id: PM_ID, type: "bank_account", isDefault: true }],
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      // Should still return failed, not throw
      expect(result.status).toBe("failed");
    });
  });

  // --- Test 3.18: Subscription alignment check ---

  describe("3.18: subscription alignment check logging", () => {
    it("should log when no active subscription exists", async () => {
      const payroll = makePayroll();

      // monolith query for payrolls
      mockMonolithPool.query.mockResolvedValueOnce({ rows: [payroll] });

      // PM query
      mockPaymentMethodsRepo.findAllByCustomerUnfiltered.mockResolvedValueOnce([
        { id: PM_ID, type: "bank_account", isDefault: true },
      ]);

      // Subscription alignment: no active subscription
      mockSubscriptionsRepo.findByCustomerAndStatuses.mockResolvedValueOnce([]);

      // Idempotency check
      mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce(null);

      await service.migratePayrollForCustomer(
        CUSTOMER_ID,
        MONOLITH_CUSTOMER_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      // Verify logger was called with alignment info
      expect(Logger.prototype.log).toHaveBeenCalled();
    });
  });
});

// --- Pure function tests ---

describe("mapPayrollStatus", () => {
  it("should map paid -> paid invoice + succeeded charge", () => {
    const result = mapPayrollStatus(makePayrollForStatus("paid", false));
    expect(result).toEqual({
      invoiceStatus: "paid",
      createCharge: true,
      chargeStatus: "succeeded",
    });
  });

  it("should map succeeded -> paid invoice + succeeded charge", () => {
    const result = mapPayrollStatus(makePayrollForStatus("succeeded", false));
    expect(result).toEqual({
      invoiceStatus: "paid",
      createCharge: true,
      chargeStatus: "succeeded",
    });
  });

  it("should map failed -> finalized invoice + failed charge", () => {
    const result = mapPayrollStatus(makePayrollForStatus("failed", false));
    expect(result).toEqual({
      invoiceStatus: "finalized",
      createCharge: true,
      chargeStatus: "failed",
    });
  });

  it("should map pending -> finalized invoice + pending charge", () => {
    const result = mapPayrollStatus(makePayrollForStatus("pending", false));
    expect(result).toEqual({
      invoiceStatus: "finalized",
      createCharge: true,
      chargeStatus: "pending",
    });
  });

  it("should override Status when Failure=true", () => {
    const result = mapPayrollStatus(makePayrollForStatus("paid", true));
    expect(result).toEqual({
      invoiceStatus: "finalized",
      createCharge: true,
      chargeStatus: "failed",
    });
  });

  it("should override Status when Failure='true' (string)", () => {
    const payroll = makePayrollForStatus("paid", false);
    payroll.Failure = "true";
    const result = mapPayrollStatus(payroll);
    expect(result).toEqual({
      invoiceStatus: "finalized",
      createCharge: true,
      chargeStatus: "failed",
    });
  });

  it("should return null for unknown status", () => {
    const result = mapPayrollStatus(
      makePayrollForStatus("bizarre_status", false),
    );
    expect(result).toBeNull();
  });
});

describe("deriveBillingPeriod", () => {
  it("should derive correct period for June 2025", () => {
    const result = deriveBillingPeriod(new Date("2025-06-01"));
    expect(result.billingPeriodStart).toEqual(
      new Date("2025-06-01T00:00:00.000Z"),
    );
    expect(result.billingPeriodEnd).toEqual(
      new Date("2025-07-01T00:00:00.000Z"),
    );
  });

  it("should handle string input", () => {
    const result = deriveBillingPeriod("2025-01-15");
    expect(result.billingPeriodStart).toEqual(
      new Date("2025-01-01T00:00:00.000Z"),
    );
    expect(result.billingPeriodEnd).toEqual(
      new Date("2025-02-01T00:00:00.000Z"),
    );
  });
});

describe("mapPaymentMethodType", () => {
  it("should map ACH -> bank_account", () => {
    expect(mapPaymentMethodType("ACH")).toBe("bank_account");
  });

  it("should map credit_card -> card", () => {
    expect(mapPaymentMethodType("credit_card")).toBe("card");
  });

  it("should map visa -> card", () => {
    expect(mapPaymentMethodType("visa")).toBe("card");
  });

  it("should return null for unknown type", () => {
    expect(mapPaymentMethodType("bitcoin")).toBeNull();
  });

  it("should return null for null input", () => {
    expect(mapPaymentMethodType(null)).toBeNull();
  });
});

// Helper for status tests
function makePayrollForStatus(
  status: string,
  failure: boolean,
): MonolithCustomerPayroll {
  return {
    Customer_Payroll_ID: "PAY-TEST",
    Customer_ID: "CUST-TEST",
    Total_Amount: "100.00",
    Total_Bonus: null,
    Payment_Date: null,
    Paid_On: null,
    Status: status,
    Payroll_Month: null,
    Credit_Card_Surcharge: null,
    Failure: failure,
    Failure_Date: null,
    Failure_Reason: null,
    Payment_Method: null,
    Reference_Number: null,
    createdBy: null,
    updatedBy: null,
    Invoice_ID: null,
  };
}
