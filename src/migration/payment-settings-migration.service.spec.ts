import { PaymentSettingsMigrationService } from "./payment-settings-migration.service";
import type { PaymentGateway } from "../gateway/gateway.interface";
import { PaymentFailedException } from "../common/exceptions/payment-failed.exception";
import type { MigrationOptions } from "./dto/migration-options.dto";
import type { CustomersRepository } from "../customers/customers.repository";
import type { MigrationLogsRepository } from "./migration-logs.repository";
import * as uuidUtil from "../common/utils/uuid.util";

jest.mock("../common/utils/uuid.util", () => {
  let callCount = 0;
  return {
    generateId: jest.fn(() => {
      callCount++;
      return `mock-uuid-${String(callCount).padStart(3, "0")}`;
    }),
    __resetCallCount: () => {
      callCount = 0;
    },
  };
});

describe("PaymentSettingsMigrationService", () => {
  let service: PaymentSettingsMigrationService;
  let mockGateway: jest.Mocked<
    Pick<PaymentGateway, "getCustomer" | "listPaymentMethods">
  >;

  // Drizzle mock — transaction only (selects go through repo)
  let txInsertChain: {
    values: jest.Mock;
    then: jest.Mock;
  };
  let txMock: {
    insert: jest.Mock;
  };
  let mockDb: {
    transaction: jest.Mock;
  };

  let mockMigrationLogsRepo: { createLog: jest.Mock };
  let mockCustomersRepo: { findByMonolithId: jest.Mock };

  let mockMonolithPool: {
    query: jest.Mock;
  };

  const defaultOptions: MigrationOptions = {
    dryRun: false,
    batchSize: 50,
    batchDelayMs: 0,
  };

  const makeStripeCustomerResult = (overrides = {}) => ({
    id: "cus_stripe_123",
    email: "test@example.com",
    name: "Test User",
    metadata: {},
    createdAt: new Date("2026-01-01"),
    defaultPaymentMethodId: null as string | null,
    ...overrides,
  });

  const makePaymentMethodResult = (overrides = {}) => ({
    id: "pm_stripe_1",
    customerId: "cus_stripe_123",
    type: "card",
    last4: "4242",
    brand: "visa",
    bankName: null,
    expiryMonth: 12,
    expiryYear: 2027,
    isDefault: true,
    fingerprint: null,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset uuid counter
    (
      uuidUtil as unknown as { __resetCallCount: () => void }
    ).__resetCallCount();

    txInsertChain = {
      values: jest.fn().mockReturnThis(),
      then: jest.fn((resolve: (val: unknown) => void) => resolve(undefined)),
    };

    txMock = {
      insert: jest.fn(() => txInsertChain),
    };

    mockDb = {
      transaction: jest.fn((cb: (tx: typeof txMock) => Promise<void>) =>
        cb(txMock),
      ),
    };

    mockMigrationLogsRepo = {
      createLog: jest.fn().mockResolvedValue(undefined),
    };

    mockGateway = {
      getCustomer: jest.fn().mockResolvedValue(makeStripeCustomerResult()),
      listPaymentMethods: jest
        .fn()
        .mockResolvedValue([makePaymentMethodResult()]),
    };

    mockMonolithPool = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };

    mockCustomersRepo = {
      findByMonolithId: jest.fn().mockResolvedValue(null),
    };

    service = new PaymentSettingsMigrationService(
      mockDb as never,
      mockMonolithPool as never,
      mockGateway as never,
      mockCustomersRepo as unknown as CustomersRepository,
      mockMigrationLogsRepo as unknown as MigrationLogsRepository,
    );

    // Mock sleep to avoid real delays
    jest
      .spyOn(service as never, "sleep" as never)
      .mockResolvedValue(undefined as never);
  });

  describe("migrateCustomer", () => {
    it("should migrate a customer successfully — happy path", async () => {
      const result = await service.migrateCustomer(
        "MONO-001",
        "cus_stripe_123",
        "ACH",
        null,
        "run-1",
        defaultOptions,
      );

      expect(result.status).toBe("succeeded");
      expect(result.monolithCustomerId).toBe("MONO-001");
      expect(result.billingCustomerId).toBeDefined();
      expect(result.paymentMethodCount).toBe(1);

      // Verify Stripe-before-DB ordering
      expect(mockGateway.getCustomer).toHaveBeenCalledWith("cus_stripe_123");
      expect(mockGateway.listPaymentMethods).toHaveBeenCalledWith(
        "cus_stripe_123",
      );

      // Verify transaction was used for atomic insert
      expect(mockDb.transaction).toHaveBeenCalled();

      // Verify migration log was written via repository
      expect(mockMigrationLogsRepo.createLog).toHaveBeenCalled();
    });

    it("should skip already-migrated customer", async () => {
      mockCustomersRepo.findByMonolithId.mockResolvedValueOnce({
        id: "existing-billing-uuid",
        monolithCustomerId: "MONO-001",
        stripeCustomerId: "cus_stripe_123",
        name: "Test",
        email: "test@example.com",
        status: "active",
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.migrateCustomer(
        "MONO-001",
        "cus_stripe_123",
        "ACH",
        null,
        "run-1",
        defaultOptions,
      );

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("already_migrated");
      expect(result.billingCustomerId).toBe("existing-billing-uuid");

      // Verify no Stripe calls
      expect(mockGateway.getCustomer).not.toHaveBeenCalled();
      expect(mockGateway.listPaymentMethods).not.toHaveBeenCalled();

      // Verify no transaction
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should fail when Stripe customer not found", async () => {
      mockGateway.getCustomer.mockRejectedValue(
        new PaymentFailedException("Stripe customer not found: cus_invalid"),
      );

      const result = await service.migrateCustomer(
        "MONO-002",
        "cus_invalid",
        "ACH",
        null,
        "run-1",
        defaultOptions,
      );

      expect(result.status).toBe("failed");
      expect(result.reason).toContain("Stripe customer not found");

      // Verify no DB writes
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should fail on Stripe API error and continue", async () => {
      mockGateway.getCustomer.mockRejectedValue(
        new Error("Stripe API timeout"),
      );

      const result = await service.migrateCustomer(
        "MONO-003",
        "cus_stripe_123",
        "ACH",
        null,
        "run-1",
        defaultOptions,
      );

      expect(result.status).toBe("failed");
      expect(result.reason).toContain("Stripe API timeout");

      // Verify migration log was still written via repository
      expect(mockMigrationLogsRepo.createLog).toHaveBeenCalled();
    });

    it("should store mandate_id in default bank_account payment method metadata", async () => {
      // Set the customer's default PM to the bank account
      mockGateway.getCustomer.mockResolvedValue(
        makeStripeCustomerResult({ defaultPaymentMethodId: "pm_bank_1" }),
      );
      mockGateway.listPaymentMethods.mockResolvedValue([
        makePaymentMethodResult({
          id: "pm_bank_1",
          type: "us_bank_account",
          last4: "6789",
          brand: null,
          bankName: "Chase",
          isDefault: false, // isDefault from adapter is always false
        }),
      ]);

      await service.migrateCustomer(
        "MONO-004",
        "cus_stripe_123",
        "ACH",
        "mandate_abc",
        "run-1",
        defaultOptions,
      );

      // Verify the payment method was inserted with mandate metadata
      expect(txMock.insert).toHaveBeenCalled();
      const insertCalls = txInsertChain.values.mock.calls;

      // Find the payment method insert (has stripePaymentMethodId)
      const pmInsertCall = insertCalls.find(
        (call) =>
          (call[0] as Record<string, unknown>).stripePaymentMethodId ===
          "pm_bank_1",
      );
      expect(pmInsertCall).toBeDefined();
      expect((pmInsertCall![0] as Record<string, unknown>).metadata).toEqual({
        mandate_id: "mandate_abc",
      });
    });

    it("should not store mandate_id for card payment methods", async () => {
      // Set the customer's default PM to the card
      mockGateway.getCustomer.mockResolvedValue(
        makeStripeCustomerResult({ defaultPaymentMethodId: "pm_card_1" }),
      );
      mockGateway.listPaymentMethods.mockResolvedValue([
        makePaymentMethodResult({
          id: "pm_card_1",
          type: "card",
          isDefault: false,
        }),
      ]);

      await service.migrateCustomer(
        "MONO-005",
        "cus_stripe_123",
        "CREDIT_CARD",
        "mandate_abc",
        "run-1",
        defaultOptions,
      );

      const insertCalls = txInsertChain.values.mock.calls;
      const pmInsertCall = insertCalls.find(
        (call) =>
          (call[0] as Record<string, unknown>).stripePaymentMethodId ===
          "pm_card_1",
      );
      expect(pmInsertCall).toBeDefined();
      expect((pmInsertCall![0] as Record<string, unknown>).metadata).toBeNull();
    });

    it("should create customer with no payment methods when Stripe returns none", async () => {
      mockGateway.listPaymentMethods.mockResolvedValue([]);

      const result = await service.migrateCustomer(
        "MONO-006",
        "cus_stripe_123",
        "ACH",
        null,
        "run-1",
        defaultOptions,
      );

      expect(result.status).toBe("succeeded");
      expect(result.paymentMethodCount).toBe(0);

      // Verify transaction was still called (customer insert only)
      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it("should not write to billing DB in dry-run mode", async () => {
      const result = await service.migrateCustomer(
        "MONO-007",
        "cus_stripe_123",
        "ACH",
        null,
        "run-1",
        { ...defaultOptions, dryRun: true },
      );

      expect(result.status).toBe("succeeded");
      expect(result.reason).toBe("dry_run");
      expect(result.paymentMethodCount).toBe(1);

      // Verify Stripe was still called for validation
      expect(mockGateway.getCustomer).toHaveBeenCalled();
      expect(mockGateway.listPaymentMethods).toHaveBeenCalled();

      // Verify NO transaction (no billing DB writes)
      expect(mockDb.transaction).not.toHaveBeenCalled();

      // Verify migration log was still written via repository
      expect(mockMigrationLogsRepo.createLog).toHaveBeenCalled();
    });

    it("should set isDefault based on stripeCustomer.defaultPaymentMethodId, not pm.isDefault", async () => {
      // Regression test for H1: default PM determined from customer object, not from listPaymentMethods
      mockGateway.getCustomer.mockResolvedValue(
        makeStripeCustomerResult({ defaultPaymentMethodId: "pm_2" }),
      );
      mockGateway.listPaymentMethods.mockResolvedValue([
        makePaymentMethodResult({
          id: "pm_1",
          type: "card",
          isDefault: false,
        }),
        makePaymentMethodResult({
          id: "pm_2",
          type: "card",
          isDefault: false,
          last4: "9999",
        }),
      ]);

      await service.migrateCustomer(
        "MONO-DEFAULT",
        "cus_stripe_123",
        "ACH",
        null,
        "run-1",
        defaultOptions,
      );

      const insertCalls = txInsertChain.values.mock.calls;

      // pm_1 should NOT be default
      const pm1Insert = insertCalls.find(
        (call) =>
          (call[0] as Record<string, unknown>).stripePaymentMethodId === "pm_1",
      );
      expect(pm1Insert).toBeDefined();
      expect((pm1Insert![0] as Record<string, unknown>).isDefault).toBe(false);

      // pm_2 should BE default (matched by defaultPaymentMethodId)
      const pm2Insert = insertCalls.find(
        (call) =>
          (call[0] as Record<string, unknown>).stripePaymentMethodId === "pm_2",
      );
      expect(pm2Insert).toBeDefined();
      expect((pm2Insert![0] as Record<string, unknown>).isDefault).toBe(true);
    });

    it("should not abort batch when writeMigrationLog fails in error handler", async () => {
      // Regression test for M1: writeMigrationLog failure in catch block
      // should not propagate and abort the batch
      mockGateway.getCustomer.mockRejectedValue(
        new Error("Stripe API timeout"),
      );

      // Make the migration log repo throw
      mockMigrationLogsRepo.createLog.mockRejectedValueOnce(
        new Error("DB connection lost"),
      );

      // Should still return a failure result, not throw
      const result = await service.migrateCustomer(
        "MONO-LOG-FAIL",
        "cus_stripe_123",
        "ACH",
        null,
        "run-1",
        defaultOptions,
      );

      expect(result.status).toBe("failed");
      expect(result.reason).toContain("Stripe API timeout");
    });

    it("should use customer name and email from Stripe", async () => {
      mockGateway.getCustomer.mockResolvedValue(
        makeStripeCustomerResult({
          name: "Stripe Name",
          email: "stripe@example.com",
        }),
      );

      await service.migrateCustomer(
        "MONO-008",
        "cus_stripe_123",
        "ACH",
        null,
        "run-1",
        defaultOptions,
      );

      // Verify customer was inserted with Stripe data
      const customerInsert = txInsertChain.values.mock.calls.find(
        (call) =>
          (call[0] as Record<string, unknown>).monolithCustomerId ===
          "MONO-008",
      );
      expect(customerInsert).toBeDefined();
      expect((customerInsert![0] as Record<string, unknown>).name).toBe(
        "Stripe Name",
      );
      expect((customerInsert![0] as Record<string, unknown>).email).toBe(
        "stripe@example.com",
      );
    });
  });

  describe("migrateAll", () => {
    it("should process customers in batches", async () => {
      mockMonolithPool.query.mockResolvedValue({
        rows: [
          {
            Customer_ID: "C1",
            Stripe_Customer_ID: "cus_1",
            Payment_Method_Type: "ACH",
            Mandate_ID: null,
          },
          {
            Customer_ID: "C2",
            Stripe_Customer_ID: "cus_2",
            Payment_Method_Type: "ACH",
            Mandate_ID: null,
          },
          {
            Customer_ID: "C3",
            Stripe_Customer_ID: "cus_3",
            Payment_Method_Type: "ACH",
            Mandate_ID: null,
          },
        ],
      });

      const summary = await service.migrateAll({
        ...defaultOptions,
        batchSize: 2,
      });

      expect(summary.totalProcessed).toBe(3);
      expect(summary.succeeded).toBe(3);
      expect(summary.failed).toBe(0);
      expect(summary.skipped).toBe(0);
      expect(summary.duration).toBeGreaterThanOrEqual(0);
    });

    it("should throw when monolith pool is not configured", async () => {
      const serviceNoMonolith = new PaymentSettingsMigrationService(
        mockDb as never,
        null,
        mockGateway as never,
        mockCustomersRepo as unknown as CustomersRepository,
        mockMigrationLogsRepo as unknown as MigrationLogsRepository,
      );

      await expect(
        serviceNoMonolith.migrateAll(defaultOptions),
      ).rejects.toThrow("Monolith database connection is not configured");
    });
  });

  describe("migrateByIds", () => {
    it("should query only specified customer IDs", async () => {
      mockMonolithPool.query.mockResolvedValue({
        rows: [
          {
            Customer_ID: "C1",
            Stripe_Customer_ID: "cus_1",
            Payment_Method_Type: "ACH",
            Mandate_ID: null,
          },
        ],
      });

      const summary = await service.migrateByIds(["C1"], defaultOptions);

      expect(summary.totalProcessed).toBe(1);
      expect(mockMonolithPool.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE"),
        [["C1"]],
      );
    });

    it("should throw when monolith pool is not configured", async () => {
      const serviceNoMonolith = new PaymentSettingsMigrationService(
        mockDb as never,
        null,
        mockGateway as never,
        mockCustomersRepo as unknown as CustomersRepository,
        mockMigrationLogsRepo as unknown as MigrationLogsRepository,
      );

      await expect(
        serviceNoMonolith.migrateByIds(["C1"], defaultOptions),
      ).rejects.toThrow("Monolith database connection is not configured");
    });
  });

  describe("summary output", () => {
    it("should produce correct counts for mixed results", async () => {
      // First customer: succeeds
      // Second customer: already exists (skip)
      // Third customer: Stripe not found (fail)

      mockMonolithPool.query.mockResolvedValue({
        rows: [
          {
            Customer_ID: "C1",
            Stripe_Customer_ID: "cus_1",
            Payment_Method_Type: "ACH",
            Mandate_ID: null,
          },
          {
            Customer_ID: "C2",
            Stripe_Customer_ID: "cus_2",
            Payment_Method_Type: "ACH",
            Mandate_ID: null,
          },
          {
            Customer_ID: "C3",
            Stripe_Customer_ID: "cus_3",
            Payment_Method_Type: "ACH",
            Mandate_ID: null,
          },
        ],
      });

      // Track calls to findByMonolithId to return different results per customer
      let findCallCount = 0;
      mockCustomersRepo.findByMonolithId.mockImplementation(() => {
        findCallCount++;
        // C2: already exists
        if (findCallCount === 2) {
          return Promise.resolve({
            id: "existing-uuid",
            monolithCustomerId: "C2",
            stripeCustomerId: "cus_2",
            name: "Test",
            email: "test@example.com",
            status: "active",
            metadata: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
        return Promise.resolve(null);
      });

      // Track calls to getCustomer — C3 fails
      let getCustomerCount = 0;
      mockGateway.getCustomer.mockImplementation(() => {
        getCustomerCount++;
        if (getCustomerCount === 2) {
          return Promise.reject(
            new PaymentFailedException("Stripe customer not found: cus_3"),
          );
        }
        return Promise.resolve(makeStripeCustomerResult());
      });

      const summary = await service.migrateAll(defaultOptions);

      expect(summary.totalProcessed).toBe(3);
      expect(summary.succeeded).toBe(1);
      expect(summary.skipped).toBe(1);
      expect(summary.failed).toBe(1);
    });
  });

  describe("dry-run mode for migrateAll", () => {
    it("should validate all customers without writing to billing DB", async () => {
      mockMonolithPool.query.mockResolvedValue({
        rows: [
          {
            Customer_ID: "C1",
            Stripe_Customer_ID: "cus_1",
            Payment_Method_Type: "ACH",
            Mandate_ID: null,
          },
        ],
      });

      const summary = await service.migrateAll({
        ...defaultOptions,
        dryRun: true,
      });

      expect(summary.totalProcessed).toBe(1);
      expect(summary.succeeded).toBe(1);
      expect(summary.scriptName).toBe("migrate-payment-settings-dry-run");

      // Verify no transaction
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });
});
