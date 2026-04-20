import { Test } from "@nestjs/testing";
import { ChargesService, SUBSCRIPTIONS_SERVICE } from "./charges.service";
import { ChargesRepository } from "./charges.repository";
import { InvoicesRepository } from "../invoices/invoices.repository";
import { PaymentMethodsRepository } from "../payment-methods/payment-methods.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import { GatewayRegistry } from "../gateway/gateway.registry";
import { LedgerService } from "../ledger/ledger.service";
import { SqsProducerService } from "../integration/sqs/sqs-producer.service";
import { PaymentMethodsService } from "../payment-methods/payment-methods.service";
import { CustomersService } from "../customers/customers.service";
import { InvoiceAlreadyPaidException } from "./invoice-already-paid.exception";
import { InvoiceNotFinalizedException } from "./invoice-not-finalized.exception";
import { NoPaymentMethodException } from "../common/exceptions/no-payment-method.exception";
import { BusinessRuleViolationException } from "../common/exceptions/billing.exception";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import { DunningService } from "../dunning/dunning.service";
import { PaymentMethodNotFoundException } from "../common/exceptions/payment-method-not-found.exception";
import { GatewayNotAvailableException } from "../common/exceptions/gateway-not-available.exception";
import { GatewayProvider } from "../common/enums/gateway-provider.enum";

const makeInvoiceRow = (overrides = {}) => ({
  id: "inv-uuid-1",
  customerId: "cust-uuid-1",
  subscriptionId: "sub-uuid-1",
  type: "recurring",
  status: "finalized",
  totalAmountCents: 5000,
  currency: "usd",
  billingPeriodStart: new Date("2026-01-01"),
  billingPeriodEnd: new Date("2026-02-01"),
  dueDate: new Date("2026-02-01"),
  paidAt: null,
  voidedAt: null,
  metadata: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...overrides,
});

const makePaymentMethodResponse = (overrides = {}) => ({
  id: "pm-uuid-1",
  customerId: "cust-uuid-1",
  stripePaymentMethodId: "pm_stripe_1",
  type: "card",
  isDefault: true,
  lastFour: "4242",
  brand: "visa",
  bankName: null,
  expiryMonth: 12,
  expiryYear: 2027,
  fallbackOrder: null,
  gatewayProvider: "stripe",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const makeCustomerResponse = (overrides = {}) => ({
  id: "cust-uuid-1",
  monolithCustomerId: "mono-1",
  stripeCustomerId: "cus_stripe_1",
  name: "Test User",
  email: "test@example.com",
  status: "active",
  metadata: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const makeGatewayChargeResult = (overrides = {}) => ({
  id: "pi_stripe_123",
  amount: 5000,
  currency: "usd",
  status: "succeeded" as const,
  customerId: "cus_stripe_1",
  paymentMethodId: "pm_stripe_1",
  failureCode: null,
  failureMessage: null,
  metadata: {},
  createdAt: new Date(),
  ...overrides,
});

const makeChargeRow = (overrides = {}) => ({
  id: "charge-uuid-1",
  invoiceId: "inv-uuid-1",
  customerId: "cust-uuid-1",
  paymentMethodId: "pm-uuid-1",
  amountCents: 5000,
  currency: "usd",
  status: "pending",
  stripePaymentIntentId: null,
  idempotencyKey: "inv_inv-uuid-1_att_1",
  failureReason: null,
  attemptNumber: 1,
  createdAt: new Date("2026-02-10"),
  updatedAt: new Date("2026-02-10"),
  ...overrides,
});

// Transaction mock chains for inline invoice/lineItem operations
let txInsertChain: { values: jest.Mock };
let txUpdateChain: { set: jest.Mock; where: jest.Mock };
let txMock: {
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
};

// DB select chain for inline payment_methods queries
let selectChain: {
  from: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
};

describe("ChargesService", () => {
  let service: ChargesService;
  let chargesRepo: jest.Mocked<ChargesRepository>;
  let invoicesRepo: jest.Mocked<InvoicesRepository>;
  let paymentMethodsRepo: jest.Mocked<PaymentMethodsRepository>;

  let mockDb: {
    select: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    transaction: jest.Mock;
  };

  let mockGateway: { createCharge: jest.Mock };
  let mockGatewayRegistry: { getAdapter: jest.Mock };
  let mockLedgerService: {
    recordPaymentSucceeded: jest.Mock;
    recordInvoiceFinalized: jest.Mock;
  };
  let mockSqsProducerService: { publish: jest.Mock };
  let mockPaymentMethodsService: {
    getDefaultPaymentMethod: jest.Mock;
    getActivePaymentMethodById: jest.Mock;
    resolveGatewayCustomerId: jest.Mock;
  };
  let mockCustomersService: { findById: jest.Mock };
  let mockSubscriptionsService: { advanceBillingPeriod: jest.Mock };
  let mockDunningService: { scheduleDunningAttempt: jest.Mock };

  beforeEach(async () => {
    selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };

    txUpdateChain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    };

    txInsertChain = {
      values: jest.fn().mockResolvedValue(undefined),
    };

    txMock = {
      select: jest.fn(() => selectChain),
      insert: jest.fn(() => txInsertChain),
      update: jest.fn(() => txUpdateChain),
    };

    mockDb = {
      select: jest.fn(() => selectChain),
      insert: jest.fn(() => txInsertChain),
      update: jest.fn(() => txUpdateChain),
      transaction: jest.fn((cb: (tx: typeof txMock) => Promise<void>) =>
        cb(txMock),
      ),
    };

    chargesRepo = {
      findById: jest.fn().mockResolvedValue(null),
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      findByStripePaymentIntentId: jest.fn().mockResolvedValue(null),
      findByInvoiceId: jest.fn().mockResolvedValue([]),
      findByCustomerWithPaymentMethod: jest.fn().mockResolvedValue([]),
      findForBillingHistory: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      createWithIdempotency: jest.fn().mockResolvedValue({
        charge: makeChargeRow(),
        isDuplicate: false,
      }),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      findByIds: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<ChargesRepository>;

    invoicesRepo = {
      findById: jest.fn().mockResolvedValue(null),
      findByIdWithLineItems: jest.fn().mockResolvedValue(null),
      findAll: jest.fn().mockResolvedValue([]),
      findPendingOnboarding: jest.fn().mockResolvedValue([]),
      findDuplicateForSubscription: jest.fn().mockResolvedValue([]),
      getLineItemsByInvoiceId: jest.fn().mockResolvedValue([]),
      getLineItemsByInvoiceIds: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(makeInvoiceRow()),
      createLineItem: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(makeInvoiceRow()),
      updateWithConcurrencyCheck: jest.fn().mockResolvedValue(null),
      findForBillingHistory: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<InvoicesRepository>;

    paymentMethodsRepo = {
      findById: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<PaymentMethodsRepository>;

    mockGateway = {
      createCharge: jest.fn(),
    };

    mockGatewayRegistry = {
      getAdapter: jest.fn().mockReturnValue(mockGateway),
    };

    mockLedgerService = {
      recordPaymentSucceeded: jest.fn().mockResolvedValue("ledger-entry-id"),
      recordInvoiceFinalized: jest.fn().mockResolvedValue("ledger-entry-id-2"),
    };

    mockSqsProducerService = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    mockPaymentMethodsService = {
      getDefaultPaymentMethod: jest.fn(),
      getActivePaymentMethodById: jest.fn(),
      resolveGatewayCustomerId: jest.fn(),
    };

    mockCustomersService = {
      findById: jest.fn(),
    };

    mockSubscriptionsService = {
      advanceBillingPeriod: jest.fn().mockResolvedValue(undefined),
    };

    mockDunningService = {
      scheduleDunningAttempt: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        ChargesService,
        { provide: ChargesRepository, useValue: chargesRepo },
        { provide: InvoicesRepository, useValue: invoicesRepo },
        { provide: PaymentMethodsRepository, useValue: paymentMethodsRepo },
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
        { provide: GatewayRegistry, useValue: mockGatewayRegistry },
        { provide: LedgerService, useValue: mockLedgerService },
        { provide: SqsProducerService, useValue: mockSqsProducerService },
        {
          provide: PaymentMethodsService,
          useValue: mockPaymentMethodsService,
        },
        { provide: CustomersService, useValue: mockCustomersService },
        {
          provide: SUBSCRIPTIONS_SERVICE,
          useValue: mockSubscriptionsService,
        },
        { provide: DunningService, useValue: mockDunningService },
      ],
    }).compile();

    service = module.get<ChargesService>(ChargesService);
  });

  describe("executePaymentForInvoice", () => {
    beforeEach(() => {
      // Default: return finalized invoice
      invoicesRepo.findById.mockResolvedValue(makeInvoiceRow());
      // Default: charge create succeeds
      chargesRepo.createWithIdempotency.mockResolvedValue({
        charge: makeChargeRow(),
        isDuplicate: false,
      });
      // Default: update status succeeds
      chargesRepo.updateStatus.mockResolvedValue(undefined);
      // Default: invoice update succeeds
      invoicesRepo.update.mockResolvedValue(makeInvoiceRow({ status: "paid" }));
      // Default: payment method found
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue(
        makePaymentMethodResponse(),
      );
      // Default: customer found with Stripe ID
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      // Default: resolve gateway customer ID (Stripe customer)
      mockPaymentMethodsService.resolveGatewayCustomerId.mockResolvedValue(
        "cus_stripe_1",
      );
      // Default: gateway succeeds
      mockGateway.createCharge.mockResolvedValue(makeGatewayChargeResult());
    });

    it("should execute a successful charge and return succeeded result", async () => {
      const result = await service.executePaymentForInvoice(
        "inv-uuid-1",
        "corr-1",
      );

      expect(result.status).toBe("succeeded");
      expect(result.stripePaymentIntentId).toBe("pi_stripe_123");
      expect(result.chargeId).toBeDefined();
    });

    it("should call gateway with correct parameters including idempotency key", async () => {
      await service.executePaymentForInvoice("inv-uuid-1", "corr-1");

      expect(mockGatewayRegistry.getAdapter).toHaveBeenCalledWith(
        GatewayProvider.Stripe,
      );
      expect(mockGateway.createCharge).toHaveBeenCalledWith({
        amount: 5000,
        currency: "usd",
        customerId: "cus_stripe_1",
        paymentMethodId: "pm_stripe_1",
        idempotencyKey: "inv_inv-uuid-1_att_1",
        description: "Invoice inv-uuid-1",
        metadata: {
          billingCustomerId: "cust-uuid-1",
          billingInvoiceId: "inv-uuid-1",
          monolithCustomerId: "mono-1",
        },
      });
    });

    it("should generate correct idempotency key format", async () => {
      await service.executePaymentForInvoice("inv-uuid-1", "corr-1", 3);

      expect(mockGateway.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: "inv_inv-uuid-1_att_3",
        }),
      );
    });

    it("should create charge record via chargesRepository.createWithIdempotency", async () => {
      await service.executePaymentForInvoice("inv-uuid-1", "corr-1");

      expect(chargesRepo.createWithIdempotency).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: "inv-uuid-1",
          customerId: "cust-uuid-1",
          paymentMethodId: "pm-uuid-1",
          amountCents: 5000,
          currency: "usd",
          status: "pending",
          idempotencyKey: "inv_inv-uuid-1_att_1",
          attemptNumber: 1,
        }),
      );
    });

    it("should update charge and invoice within a transaction on success", async () => {
      await service.executePaymentForInvoice("inv-uuid-1", "corr-1");

      expect(mockDb.transaction).toHaveBeenCalled();
      // charge update via repository
      expect(chargesRepo.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: "succeeded",
          stripePaymentIntentId: "pi_stripe_123",
        }),
        txMock,
      );
      // invoice update via repository
      expect(invoicesRepo.update).toHaveBeenCalledWith(
        "inv-uuid-1",
        expect.objectContaining({
          status: "paid",
        }),
        txMock,
      );
    });

    it("should create ledger entry within the transaction", async () => {
      await service.executePaymentForInvoice("inv-uuid-1", "corr-1");

      expect(mockLedgerService.recordPaymentSucceeded).toHaveBeenCalledWith(
        expect.any(String), // chargeId
        5000,
        "usd",
        "corr-1",
        txMock, // transaction context
      );
    });

    it("should advance subscription billing period on success", async () => {
      await service.executePaymentForInvoice("inv-uuid-1", "corr-1");

      expect(
        mockSubscriptionsService.advanceBillingPeriod,
      ).toHaveBeenCalledWith("sub-uuid-1", "corr-1");
    });

    it("should publish payment.succeeded and invoice.paid events", async () => {
      await service.executePaymentForInvoice("inv-uuid-1", "corr-1");

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "payment.succeeded",
        expect.objectContaining({
          invoiceId: "inv-uuid-1",
          customerId: "cust-uuid-1",
          amountCents: 5000,
          currency: "usd",
          paymentMethodId: "pm-uuid-1",
          stripePaymentIntentId: "pi_stripe_123",
        }),
        "corr-1",
        undefined,
      );

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "invoice.paid",
        expect.objectContaining({
          invoiceId: "inv-uuid-1",
          customerId: "cust-uuid-1",
          totalAmountCents: 5000,
          currency: "usd",
        }),
        "corr-1",
        undefined,
      );
    });

    it("should handle failed charge: gateway throws error", async () => {
      mockGateway.createCharge.mockRejectedValue(new Error("Card declined"));

      const result = await service.executePaymentForInvoice(
        "inv-uuid-1",
        "corr-1",
      );

      expect(result.status).toBe("failed");
      expect(result.stripePaymentIntentId).toBeNull();
      // Should update charge to failed via repository
      expect(chargesRepo.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: "failed",
          failureReason: "Card declined",
        }),
      );
    });

    it("should publish payment.failed event on failure", async () => {
      mockGateway.createCharge.mockRejectedValue(new Error("Card declined"));

      await service.executePaymentForInvoice("inv-uuid-1", "corr-1");

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "payment.failed",
        expect.objectContaining({
          invoiceId: "inv-uuid-1",
          customerId: "cust-uuid-1",
          amountCents: 5000,
          currency: "usd",
          failureReason: "Card declined",
          attemptNumber: 1,
        }),
        "corr-1",
        undefined,
      );
    });

    it("should NOT advance billing period or publish success events on failure", async () => {
      mockGateway.createCharge.mockRejectedValue(new Error("Card declined"));

      await service.executePaymentForInvoice("inv-uuid-1", "corr-1");

      expect(
        mockSubscriptionsService.advanceBillingPeriod,
      ).not.toHaveBeenCalled();
      expect(mockSqsProducerService.publish).not.toHaveBeenCalledWith(
        "payment.succeeded",
        expect.anything(),
        expect.anything(),
      );
      expect(mockSqsProducerService.publish).not.toHaveBeenCalledWith(
        "invoice.paid",
        expect.anything(),
        expect.anything(),
      );
    });

    it("should throw InvoiceAlreadyPaidException for paid invoice", async () => {
      invoicesRepo.findById.mockResolvedValue(
        makeInvoiceRow({ status: "paid" }),
      );

      await expect(
        service.executePaymentForInvoice("inv-uuid-1", "corr-1"),
      ).rejects.toThrow(InvoiceAlreadyPaidException);

      expect(mockGateway.createCharge).not.toHaveBeenCalled();
    });

    it("should throw InvoiceNotFinalizedException for draft invoice", async () => {
      invoicesRepo.findById.mockResolvedValue(
        makeInvoiceRow({ status: "draft" }),
      );

      await expect(
        service.executePaymentForInvoice("inv-uuid-1", "corr-1"),
      ).rejects.toThrow(InvoiceNotFinalizedException);

      expect(mockGateway.createCharge).not.toHaveBeenCalled();
    });

    it("should throw NoPaymentMethodException when no default payment method", async () => {
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue(null);

      await expect(
        service.executePaymentForInvoice("inv-uuid-1", "corr-1"),
      ).rejects.toThrow(NoPaymentMethodException);

      expect(mockGateway.createCharge).not.toHaveBeenCalled();
    });

    it("should throw BusinessRuleViolationException when customer has no Stripe ID", async () => {
      mockCustomersService.findById.mockResolvedValue(
        makeCustomerResponse({ stripeCustomerId: null }),
      );
      mockPaymentMethodsService.resolveGatewayCustomerId.mockRejectedValue(
        new BusinessRuleViolationException(
          "Customer cust-uuid-1 has no linked Stripe account",
        ),
      );

      await expect(
        service.executePaymentForInvoice("inv-uuid-1", "corr-1"),
      ).rejects.toThrow(BusinessRuleViolationException);

      expect(mockGateway.createCharge).not.toHaveBeenCalled();
    });

    it("should throw BusinessRuleViolationException when invoice not found", async () => {
      invoicesRepo.findById.mockResolvedValue(null);

      await expect(
        service.executePaymentForInvoice("inv-uuid-1", "corr-1"),
      ).rejects.toThrow(BusinessRuleViolationException);
    });

    it("should handle idempotency: duplicate charge returns existing", async () => {
      const existingCharge = makeChargeRow({
        id: "existing-charge-id",
        status: "succeeded",
        stripePaymentIntentId: "pi_existing",
      });

      chargesRepo.createWithIdempotency.mockResolvedValue({
        charge: existingCharge,
        isDuplicate: true,
      });

      const result = await service.executePaymentForInvoice(
        "inv-uuid-1",
        "corr-1",
      );

      expect(result.chargeId).toBe("existing-charge-id");
      expect(result.status).toBe("succeeded");
      expect(result.stripePaymentIntentId).toBe("pi_existing");
      expect(mockGateway.createCharge).not.toHaveBeenCalled();
    });

    it("should detect idempotency via drizzle-orm wrapped error (error.cause.code)", async () => {
      const existingCharge = makeChargeRow({
        id: "existing-charge-id",
        status: "succeeded",
        stripePaymentIntentId: "pi_existing",
      });

      // The repository handles both error.code and error.cause.code internally
      chargesRepo.createWithIdempotency.mockResolvedValue({
        charge: existingCharge,
        isDuplicate: true,
      });

      const result = await service.executePaymentForInvoice(
        "inv-uuid-1",
        "corr-1",
      );

      expect(result.chargeId).toBe("existing-charge-id");
      expect(result.status).toBe("succeeded");
      expect(result.stripePaymentIntentId).toBe("pi_existing");
      expect(mockGateway.createCharge).not.toHaveBeenCalled();
    });

    it("should not fail when advanceBillingPeriod throws", async () => {
      mockSubscriptionsService.advanceBillingPeriod.mockRejectedValue(
        new Error("Subscription not found"),
      );

      const result = await service.executePaymentForInvoice(
        "inv-uuid-1",
        "corr-1",
      );

      // Payment still succeeds
      expect(result.status).toBe("succeeded");
    });

    it("should not advance billing period when invoice has no subscriptionId", async () => {
      invoicesRepo.findById.mockResolvedValue(
        makeInvoiceRow({ subscriptionId: null }),
      );

      await service.executePaymentForInvoice("inv-uuid-1", "corr-1");

      expect(
        mockSubscriptionsService.advanceBillingPeriod,
      ).not.toHaveBeenCalled();
    });

    it("should call dunningService.scheduleDunningAttempt on payment failure for subscription invoice", async () => {
      mockGateway.createCharge.mockRejectedValue(new Error("Card declined"));

      await service.executePaymentForInvoice("inv-uuid-1", "corr-1");

      expect(mockDunningService.scheduleDunningAttempt).toHaveBeenCalledWith(
        "inv-uuid-1",
        "corr-1",
      );
    });

    it("should NOT schedule dunning when invoice has no subscriptionId", async () => {
      invoicesRepo.findById.mockResolvedValue(
        makeInvoiceRow({ subscriptionId: null }),
      );
      mockGateway.createCharge.mockRejectedValue(new Error("Card declined"));

      await service.executePaymentForInvoice("inv-uuid-1", "corr-1");

      expect(mockDunningService.scheduleDunningAttempt).not.toHaveBeenCalled();
    });

    it("should NOT schedule dunning on subsequent attempts (attemptNumber > 1)", async () => {
      mockGateway.createCharge.mockRejectedValue(new Error("Card declined"));

      await service.executePaymentForInvoice("inv-uuid-1", "corr-1", 2);

      expect(mockDunningService.scheduleDunningAttempt).not.toHaveBeenCalled();
    });

    it("should not fail charge recording when dunning scheduling throws", async () => {
      mockGateway.createCharge.mockRejectedValue(new Error("Card declined"));
      mockDunningService.scheduleDunningAttempt.mockRejectedValue(
        new Error("DB error"),
      );

      const result = await service.executePaymentForInvoice(
        "inv-uuid-1",
        "corr-1",
      );

      // Charge is still recorded as failed
      expect(result.status).toBe("failed");
    });

    it("should load specific PM via getActivePaymentMethodById when paymentMethodId is provided", async () => {
      const specificPm = makePaymentMethodResponse({
        id: "pm-specific",
        stripePaymentMethodId: "pm_stripe_specific",
        isDefault: false,
        fallbackOrder: 1,
      });
      mockPaymentMethodsService.getActivePaymentMethodById.mockResolvedValue(
        specificPm,
      );

      const result = await service.executePaymentForInvoice(
        "inv-uuid-1",
        "corr-1",
        2,
        "pm-specific",
      );

      expect(result.status).toBe("succeeded");
      expect(
        mockPaymentMethodsService.getActivePaymentMethodById,
      ).toHaveBeenCalledWith("cust-uuid-1", "pm-specific");
      expect(
        mockPaymentMethodsService.getDefaultPaymentMethod,
      ).not.toHaveBeenCalled();
      // Verify gateway receives the specific PM's stripe token
      expect(mockGateway.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentMethodId: "pm_stripe_specific",
        }),
      );
    });

    it("should use default PM when no paymentMethodId provided (backward compatible)", async () => {
      const result = await service.executePaymentForInvoice(
        "inv-uuid-1",
        "corr-1",
        1,
      );

      expect(result.status).toBe("succeeded");
      expect(
        mockPaymentMethodsService.getDefaultPaymentMethod,
      ).toHaveBeenCalledWith("cust-uuid-1");
      expect(
        mockPaymentMethodsService.getActivePaymentMethodById,
      ).not.toHaveBeenCalled();
      expect(mockGateway.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentMethodId: "pm_stripe_1",
        }),
      );
    });

    it("should propagate PaymentMethodNotFoundException when explicit PM not found", async () => {
      mockPaymentMethodsService.getActivePaymentMethodById.mockRejectedValue(
        new PaymentMethodNotFoundException("pm-missing"),
      );

      await expect(
        service.executePaymentForInvoice(
          "inv-uuid-1",
          "corr-1",
          1,
          "pm-missing",
        ),
      ).rejects.toThrow(PaymentMethodNotFoundException);
      expect(
        mockPaymentMethodsService.getDefaultPaymentMethod,
      ).not.toHaveBeenCalled();
    });

    it("should handle GatewayNotAvailableException as failed charge when adapter not registered", async () => {
      mockGatewayRegistry.getAdapter.mockImplementation(() => {
        throw new GatewayNotAvailableException(GatewayProvider.Stripe);
      });

      const result = await service.executePaymentForInvoice(
        "inv-uuid-1",
        "corr-1",
      );

      expect(result.status).toBe("failed");
      expect(mockGateway.createCharge).not.toHaveBeenCalled();
      // Should update charge to failed via repository
      expect(chargesRepo.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: "failed",
          failureReason: expect.stringContaining("not available"),
        }),
      );
    });

    it("should resolve gateway customer ID via PaymentMethodsService for Adyen PM", async () => {
      // PM with Adyen gateway
      const adyenPm = makePaymentMethodResponse({
        id: "pm-adyen-1",
        stripePaymentMethodId: "ADYEN_TOKEN_001",
        gatewayProvider: "adyen",
      });
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue(
        adyenPm,
      );

      // Customer without stripeCustomerId (Adyen-only)
      mockCustomersService.findById.mockResolvedValue(
        makeCustomerResponse({ stripeCustomerId: null }),
      );

      // resolveGatewayCustomerId returns Adyen shopper reference
      mockPaymentMethodsService.resolveGatewayCustomerId.mockResolvedValue(
        "SHOPPER_REF_001",
      );

      mockGateway.createCharge.mockResolvedValue(
        makeGatewayChargeResult({
          id: "ADYEN_PSP_123",
          customerId: "SHOPPER_REF_001",
          paymentMethodId: "ADYEN_TOKEN_001",
        }),
      );

      const result = await service.executePaymentForInvoice(
        "inv-uuid-1",
        "corr-1",
      );

      expect(result.status).toBe("succeeded");
      expect(
        mockPaymentMethodsService.resolveGatewayCustomerId,
      ).toHaveBeenCalledWith(
        "cust-uuid-1",
        GatewayProvider.Adyen,
        expect.objectContaining({ stripeCustomerId: null }),
      );
      expect(mockGatewayRegistry.getAdapter).toHaveBeenCalledWith(
        GatewayProvider.Adyen,
      );
      expect(mockGateway.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "SHOPPER_REF_001",
          paymentMethodId: "ADYEN_TOKEN_001",
        }),
      );
    });

    it("should throw BusinessRuleViolationException when Adyen gateway assignment is missing", async () => {
      const adyenPm = makePaymentMethodResponse({
        id: "pm-adyen-no-assignment",
        stripePaymentMethodId: "ADYEN_TOKEN_002",
        gatewayProvider: "adyen",
      });
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue(
        adyenPm,
      );

      mockCustomersService.findById.mockResolvedValue(
        makeCustomerResponse({ stripeCustomerId: null }),
      );

      // resolveGatewayCustomerId throws when no assignment
      mockPaymentMethodsService.resolveGatewayCustomerId.mockRejectedValue(
        new BusinessRuleViolationException(
          "Customer cust-uuid-1 has no adyen gateway assignment",
        ),
      );

      const promise = service.executePaymentForInvoice("inv-uuid-1", "corr-1");

      await expect(promise).rejects.toThrow(BusinessRuleViolationException);
      await expect(promise).rejects.toThrow("no adyen gateway assignment");

      expect(mockGateway.createCharge).not.toHaveBeenCalled();
    });

    it("should resolve Stripe customer ID via PaymentMethodsService (backward compatible)", async () => {
      // Existing default PM has gatewayProvider: 'stripe'
      const result = await service.executePaymentForInvoice(
        "inv-uuid-1",
        "corr-1",
      );

      expect(result.status).toBe("succeeded");
      expect(
        mockPaymentMethodsService.resolveGatewayCustomerId,
      ).toHaveBeenCalledWith(
        "cust-uuid-1",
        GatewayProvider.Stripe,
        expect.objectContaining({ stripeCustomerId: "cus_stripe_1" }),
      );
      expect(mockGateway.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cus_stripe_1",
        }),
      );
    });

    it("should record correct paymentMethodId in charge when using explicit PM", async () => {
      const specificPm = makePaymentMethodResponse({
        id: "pm-fallback-1",
        stripePaymentMethodId: "pm_stripe_fallback",
      });
      mockPaymentMethodsService.getActivePaymentMethodById.mockResolvedValue(
        specificPm,
      );

      await service.executePaymentForInvoice(
        "inv-uuid-1",
        "corr-1",
        2,
        "pm-fallback-1",
      );

      // Verify the charge create includes the explicit PM id
      expect(chargesRepo.createWithIdempotency).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentMethodId: "pm-fallback-1",
        }),
      );
    });
  });

  describe("createOneTimeCharge", () => {
    const dto = {
      customerId: "cust-uuid-1",
      amountCents: 5000,
      description: "Setup fee",
    };
    const idempotencyKey = "one-time-idem-key";
    const correlationId = "corr-1";

    const makeInvoiceDbRow = (overrides = {}) => ({
      id: "inv-uuid-1",
      customerId: "cust-uuid-1",
      subscriptionId: null,
      type: "recurring",
      status: "paid",
      totalAmountCents: 5000,
      currency: "usd",
      billingPeriodStart: new Date("2026-02-10"),
      billingPeriodEnd: new Date("2026-02-10"),
      dueDate: new Date("2026-02-10"),
      paidAt: new Date("2026-02-10"),
      voidedAt: null,
      metadata: null,
      createdAt: new Date("2026-02-10"),
      updatedAt: new Date("2026-02-10"),
      ...overrides,
    });

    const makeLineItemDbRow = (overrides = {}) => ({
      id: "li-uuid-1",
      invoiceId: "inv-uuid-1",
      type: "one_time_charge",
      description: "Setup fee",
      amountCents: 5000,
      quantity: 1,
      breakdown: null,
      createdAt: new Date("2026-02-10"),
      ...overrides,
    });

    const makeChargeDbRow = (overrides = {}) => ({
      id: "charge-uuid-1",
      invoiceId: "inv-uuid-1",
      customerId: "cust-uuid-1",
      paymentMethodId: "pm-uuid-1",
      amountCents: 5000,
      currency: "usd",
      status: "succeeded",
      stripePaymentIntentId: "pi_stripe_123",
      idempotencyKey: "one-time-idem-key",
      failureReason: null,
      attemptNumber: 1,
      createdAt: new Date("2026-02-10"),
      updatedAt: new Date("2026-02-10"),
      ...overrides,
    });

    beforeEach(() => {
      // Default: customer exists
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      // Default: payment method found
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue(
        makePaymentMethodResponse(),
      );
      // Default: resolve gateway customer ID (Stripe customer)
      mockPaymentMethodsService.resolveGatewayCustomerId.mockResolvedValue(
        "cus_stripe_1",
      );
      // Default: gateway succeeds
      mockGateway.createCharge.mockResolvedValue(makeGatewayChargeResult());
      // Default: no existing charges (idempotency check returns null)
      chargesRepo.findByIdempotencyKey.mockResolvedValue(null);
      // Default: charge create succeeds
      chargesRepo.createWithIdempotency.mockResolvedValue({
        charge: makeChargeDbRow(),
        isDuplicate: false,
      });
      // Default: charge findById returns charge
      chargesRepo.findById.mockResolvedValue(makeChargeDbRow());
      // Default: invoice update succeeds
      invoicesRepo.update.mockResolvedValue(makeInvoiceDbRow());
      // Default: loadInvoiceWithLineItems
      invoicesRepo.findByIdWithLineItems.mockResolvedValue({
        invoice: makeInvoiceDbRow(),
        lineItems: [makeLineItemDbRow()],
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("should create invoice, finalize, execute payment, and return result", async () => {
      const result = await service.createOneTimeCharge(
        dto,
        idempotencyKey,
        correlationId,
      );

      expect(result.charge).toBeDefined();
      expect(result.invoice).toBeDefined();
      expect(result.invoice.lineItems).toHaveLength(1);
      expect(result.invoice.lineItems[0].type).toBe("one_time_charge");
      // Verify transaction was called (invoice + line item + finalize + ledger)
      expect(mockDb.transaction).toHaveBeenCalled();
      // Verify gateway was called
      expect(mockGateway.createCharge).toHaveBeenCalled();
      // Verify ledger entries
      expect(mockLedgerService.recordInvoiceFinalized).toHaveBeenCalled();
    });

    it("should throw CustomerNotFoundException when customer does not exist", async () => {
      mockCustomersService.findById.mockResolvedValue(null);

      await expect(
        service.createOneTimeCharge(dto, idempotencyKey, correlationId),
      ).rejects.toThrow(CustomerNotFoundException);

      expect(mockGateway.createCharge).not.toHaveBeenCalled();
    });

    it("should return existing result on duplicate idempotency key", async () => {
      const existingCharge = makeChargeDbRow();
      chargesRepo.findByIdempotencyKey.mockResolvedValue(existingCharge);

      const result = await service.createOneTimeCharge(
        dto,
        idempotencyKey,
        correlationId,
      );

      expect(result.charge.id).toBe("charge-uuid-1");
      // Should NOT create new invoice or call gateway
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockGateway.createCharge).not.toHaveBeenCalled();
    });

    it("should throw NoPaymentMethodException when no default payment method", async () => {
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue(null);

      await expect(
        service.createOneTimeCharge(dto, idempotencyKey, correlationId),
      ).rejects.toThrow(NoPaymentMethodException);

      expect(mockGateway.createCharge).not.toHaveBeenCalled();
    });

    it("should use explicit paymentMethodId and look up its Stripe ID", async () => {
      const dtoWithPm = { ...dto, paymentMethodId: "pm-explicit-1" };

      const pmDbRow = {
        id: "pm-explicit-1",
        customerId: "cust-uuid-1",
        stripePaymentMethodId: "pm_stripe_explicit",
        type: "card",
        isDefault: false,
        lastFour: "1234",
        brand: "mastercard",
        bankName: null,
        expiryMonth: 12,
        expiryYear: 2027,
        fallbackOrder: null,
        gatewayProvider: "stripe",
        status: "active",
        metadata: null,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      };

      // PM lookup via PaymentMethodsRepository.findById
      paymentMethodsRepo.findById.mockResolvedValueOnce(pmDbRow);

      chargesRepo.findById.mockResolvedValue(
        makeChargeDbRow({ paymentMethodId: "pm-explicit-1" }),
      );

      const result = await service.createOneTimeCharge(
        dtoWithPm,
        idempotencyKey,
        correlationId,
      );

      expect(result.charge).toBeDefined();
      expect(result.charge.paymentMethodId).toBe("pm-explicit-1");
      // Verify gateway was called with the explicit PM's Stripe ID
      expect(mockGateway.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentMethodId: "pm_stripe_explicit",
        }),
      );
      // Should NOT have called getDefaultPaymentMethod
      expect(
        mockPaymentMethodsService.getDefaultPaymentMethod,
      ).not.toHaveBeenCalled();
    });

    it("should handle payment failure gracefully", async () => {
      mockGateway.createCharge.mockRejectedValue(new Error("Card declined"));

      chargesRepo.findById.mockResolvedValue(
        makeChargeDbRow({
          status: "failed",
          stripePaymentIntentId: null,
          failureReason: "Card declined",
        }),
      );

      invoicesRepo.findByIdWithLineItems.mockResolvedValue({
        invoice: makeInvoiceDbRow({ status: "finalized", paidAt: null }),
        lineItems: [makeLineItemDbRow()],
      });

      const result = await service.createOneTimeCharge(
        dto,
        idempotencyKey,
        correlationId,
      );

      // Invoice created but payment failed — charge returned with failed status
      expect(result.charge.status).toBe("failed");
      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "payment.failed",
        expect.objectContaining({
          failureReason: "Card declined",
        }),
        correlationId,
        undefined,
      );
    });

    it("should throw BusinessRuleViolationException when customer has no Stripe ID", async () => {
      mockCustomersService.findById.mockResolvedValue(
        makeCustomerResponse({ stripeCustomerId: null }),
      );
      mockPaymentMethodsService.resolveGatewayCustomerId.mockRejectedValue(
        new BusinessRuleViolationException(
          "Customer cust-uuid-1 has no linked Stripe account",
        ),
      );

      await expect(
        service.createOneTimeCharge(dto, idempotencyKey, correlationId),
      ).rejects.toThrow(BusinessRuleViolationException);
    });

    it("should detect idempotency via drizzle-orm wrapped error in executePaymentForInvoiceWithPaymentMethod", async () => {
      const existingCharge = makeChargeDbRow({
        id: "existing-charge-id",
        stripePaymentIntentId: "pi_existing",
        idempotencyKey,
      });

      // The repository handles the wrapped error internally
      chargesRepo.createWithIdempotency.mockResolvedValue({
        charge: existingCharge,
        isDuplicate: true,
      });
      chargesRepo.findById.mockResolvedValue(existingCharge);

      const result = await service.createOneTimeCharge(
        dto,
        idempotencyKey,
        correlationId,
      );

      expect(result.charge.id).toBe("existing-charge-id");
      expect(result.charge.status).toBe("succeeded");
      expect(result.charge.stripePaymentIntentId).toBe("pi_existing");
      expect(mockGateway.createCharge).not.toHaveBeenCalled();
    });
  });

  describe("createOnboardingCharge", () => {
    // 30 days ahead of "now" so the suite stays green regardless of when it runs.
    const futureDate = new Date(Date.now() + 30 * 86400000)
      .toISOString()
      .split("T")[0];

    const dto = {
      customerId: "cust-uuid-1",
      amountCents: 15000,
      description: "Onboarding implementation fee",
      scheduledDate: "2027-03-01",
    };
    const correlationId = "corr-1";

    const makeInvoiceDbRow = (overrides = {}) => ({
      id: "inv-uuid-1",
      customerId: "cust-uuid-1",
      subscriptionId: null,
      type: "recurring",
      status: "draft",
      totalAmountCents: 15000,
      currency: "usd",
      billingPeriodStart: new Date("2027-03-01"),
      billingPeriodEnd: new Date("2027-03-01"),
      dueDate: new Date("2027-03-01"),
      paidAt: null,
      voidedAt: null,
      metadata: null,
      createdAt: new Date("2026-02-10"),
      updatedAt: new Date("2026-02-10"),
      ...overrides,
    });

    const makeLineItemDbRow = (overrides = {}) => ({
      id: "li-uuid-1",
      invoiceId: "inv-uuid-1",
      type: "onboarding_fee",
      description: "Onboarding implementation fee",
      amountCents: 15000,
      quantity: 1,
      breakdown: null,
      createdAt: new Date("2026-02-10"),
      ...overrides,
    });

    beforeEach(() => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      invoicesRepo.findByIdWithLineItems.mockResolvedValue({
        invoice: makeInvoiceDbRow(),
        lineItems: [makeLineItemDbRow()],
      });
    });

    it("should create draft invoice without finalization or payment", async () => {
      const result = await service.createOnboardingCharge(dto, correlationId);

      expect(result.invoice).toBeDefined();
      expect(result.invoice.status).toBe("draft");
      expect(result.invoice.lineItems).toHaveLength(1);
      expect(result.invoice.lineItems[0].type).toBe("onboarding_fee");
      // Verify transaction was called (invoice + line item + update total)
      expect(mockDb.transaction).toHaveBeenCalled();
      // Verify NO gateway call
      expect(mockGateway.createCharge).not.toHaveBeenCalled();
      // Verify NO ledger entries
      expect(mockLedgerService.recordInvoiceFinalized).not.toHaveBeenCalled();
      // Verify NO SQS events
      expect(mockSqsProducerService.publish).not.toHaveBeenCalled();
    });

    it("should throw CustomerNotFoundException when customer does not exist", async () => {
      mockCustomersService.findById.mockResolvedValue(null);

      await expect(
        service.createOnboardingCharge(dto, correlationId),
      ).rejects.toThrow(CustomerNotFoundException);

      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should throw BusinessRuleViolationException when scheduledDate is in the past", async () => {
      const pastDto = { ...dto, scheduledDate: "2020-01-01" };

      await expect(
        service.createOnboardingCharge(pastDto, correlationId),
      ).rejects.toThrow(BusinessRuleViolationException);

      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should set dueDate to scheduledDate", async () => {
      const result = await service.createOnboardingCharge(dto, correlationId);

      // The dueDate should be the scheduled date
      expect(result.invoice.dueDate).toContain("2027-03-01");
    });
  });

  describe("findByInvoiceId", () => {
    it("should return charges for an invoice", async () => {
      const chargeRow = {
        id: "charge-1",
        invoiceId: "inv-uuid-1",
        customerId: "cust-uuid-1",
        paymentMethodId: "pm-uuid-1",
        amountCents: 5000,
        currency: "usd",
        status: "succeeded",
        stripePaymentIntentId: "pi_123",
        idempotencyKey: "inv_inv-uuid-1_att_1",
        failureReason: null,
        attemptNumber: 1,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      };

      chargesRepo.findByInvoiceId.mockResolvedValue([chargeRow]);

      const result = await service.findByInvoiceId("inv-uuid-1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("charge-1");
      expect(result[0].status).toBe("succeeded");
    });

    it("should return empty array when no charges exist", async () => {
      chargesRepo.findByInvoiceId.mockResolvedValue([]);

      const result = await service.findByInvoiceId("inv-uuid-1");

      expect(result).toEqual([]);
    });
  });

  describe("metadata on PaymentIntent", () => {
    describe("executePaymentForInvoice — metadata", () => {
      beforeEach(() => {
        invoicesRepo.findById.mockResolvedValue(makeInvoiceRow());
        chargesRepo.createWithIdempotency.mockResolvedValue({
          charge: makeChargeRow(),
          isDuplicate: false,
        });
        chargesRepo.updateStatus.mockResolvedValue(undefined);
        invoicesRepo.update.mockResolvedValue(
          makeInvoiceRow({ status: "paid" }),
        );
        mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue(
          makePaymentMethodResponse(),
        );
        mockCustomersService.findById.mockResolvedValue(
          makeCustomerResponse(),
        );
        mockPaymentMethodsService.resolveGatewayCustomerId.mockResolvedValue(
          "cus_stripe_1",
        );
        mockGateway.createCharge.mockResolvedValue(makeGatewayChargeResult());
      });

      it("should include billingCustomerId, billingInvoiceId, and monolithCustomerId in gateway metadata", async () => {
        await service.executePaymentForInvoice("inv-uuid-1", "corr-meta-1");

        expect(mockGateway.createCharge).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: {
              billingCustomerId: "cust-uuid-1",
              billingInvoiceId: "inv-uuid-1",
              monolithCustomerId: "mono-1",
            },
          }),
        );
      });

      it("should pass empty string for monolithCustomerId when customer has null monolithCustomerId", async () => {
        mockCustomersService.findById.mockResolvedValue(
          makeCustomerResponse({ monolithCustomerId: null }),
        );

        await service.executePaymentForInvoice("inv-uuid-1", "corr-meta-2");

        expect(mockGateway.createCharge).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({
              monolithCustomerId: "",
            }),
          }),
        );
      });
    });

    describe("executePaymentForInvoiceWithPaymentMethod (via createOneTimeCharge) — metadata", () => {
      const dto = {
        customerId: "cust-uuid-1",
        amountCents: 5000,
        description: "Setup fee",
      };
      const idempotencyKey = "meta-test-idem";
      const correlationId = "corr-meta-ot";

      beforeEach(() => {
        mockCustomersService.findById.mockResolvedValue(
          makeCustomerResponse(),
        );
        mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue(
          makePaymentMethodResponse(),
        );
        mockPaymentMethodsService.resolveGatewayCustomerId.mockResolvedValue(
          "cus_stripe_1",
        );
        mockGateway.createCharge.mockResolvedValue(makeGatewayChargeResult());
        chargesRepo.findByIdempotencyKey.mockResolvedValue(null);
        chargesRepo.createWithIdempotency.mockResolvedValue({
          charge: makeChargeRow(),
          isDuplicate: false,
        });
        chargesRepo.findById.mockResolvedValue(makeChargeRow());
        invoicesRepo.update.mockResolvedValue(
          makeInvoiceRow({ status: "paid" }),
        );
        invoicesRepo.findByIdWithLineItems.mockResolvedValue({
          invoice: makeInvoiceRow({ status: "paid" }),
          lineItems: [
            {
              id: "li-1",
              invoiceId: "inv-uuid-1",
              type: "one_time_charge",
              description: "Setup fee",
              amountCents: 5000,
              quantity: 1,
              breakdown: null,
              createdAt: new Date(),
            },
          ],
        });
      });

      it("should include billingCustomerId, billingInvoiceId, and monolithCustomerId in gateway metadata", async () => {
        await service.createOneTimeCharge(dto, idempotencyKey, correlationId);

        expect(mockGateway.createCharge).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: {
              billingCustomerId: "cust-uuid-1",
              billingInvoiceId: expect.any(String),
              monolithCustomerId: "mono-1",
            },
          }),
        );
      });

      it("should pass monolithCustomerId from customer record (not undefined)", async () => {
        await service.createOneTimeCharge(dto, idempotencyKey, correlationId);

        const gatewayCall = mockGateway.createCharge.mock.calls[0][0];
        expect(gatewayCall.metadata.monolithCustomerId).toBe("mono-1");
        expect(gatewayCall.metadata.billingCustomerId).toBe("cust-uuid-1");
        expect(gatewayCall.metadata.billingInvoiceId).toBeTruthy();
      });
    });
  });
});
