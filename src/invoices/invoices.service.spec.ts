import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvoicesService } from "./invoices.service";
import { InvoicesRepository } from "./invoices.repository";
import { SubscriptionsRepository } from "../subscriptions/subscriptions.repository";
import { LedgerService } from "../ledger/ledger.service";
import { CreditsService } from "../credits/credits.service";
import { SurchargeConfigService } from "../surcharges/surcharge-config.service";
import { PaymentMethodsService } from "../payment-methods/payment-methods.service";
import { SqsProducerService } from "../integration/sqs/sqs-producer.service";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import { CustomersService } from "../customers/customers.service";
import { StateTransitionException } from "../common/exceptions/billing.exception";
import { InvoiceNotFoundException } from "./invoice-not-found.exception";
import { InvoiceAlreadyPaidException } from "./exceptions/invoice-already-paid.exception";
import { InvoiceNotFinalizedException } from "./exceptions/invoice-not-finalized.exception";
import { InvoiceAlreadyVoidedException } from "./exceptions/invoice-already-voided.exception";

const now = new Date("2026-03-01T00:00:00.000Z");

const mockSubscription = {
  id: "sub-123",
  customerId: "cust-123",
  planName: "standard-monthly",
  status: "active",
  amountCents: 5000,
  currency: "usd",
  billingInterval: "monthly",
  billingPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
  nextBillingDate: new Date("2026-03-01T00:00:00.000Z"),
  stripeSubscriptionId: null,
  metadata: null,
  createdAt: now,
  updatedAt: now,
};

const mockInvoiceRow = {
  id: "inv-123",
  customerId: "cust-123",
  subscriptionId: "sub-123",
  type: "recurring",
  status: "finalized",
  totalAmountCents: 5000,
  currency: "usd",
  billingPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
  dueDate: new Date("2026-04-01T00:00:00.000Z"),
  paidAt: null,
  voidedAt: null,
  metadata: null,
  createdAt: now,
  updatedAt: now,
};

const mockLineItemRow = {
  id: "li-123",
  invoiceId: "inv-123",
  type: "base_fee",
  description: "standard-monthly - monthly subscription",
  amountCents: 5000,
  quantity: 1,
  breakdown: null,
  createdAt: now,
};

const mockSubscriptionsRepo = {
  findDueForBilling: jest.fn().mockResolvedValue([]),
};

const txMock = { id: "tx-mock" };

const mockDb = {
  transaction: jest.fn((cb: (tx: typeof txMock) => Promise<unknown>) =>
    cb(txMock),
  ),
};

const mockLedgerService = {
  recordInvoiceFinalized: jest.fn().mockResolvedValue("ledger-123"),
  recordInvoiceVoided: jest.fn().mockResolvedValue("ledger-void-123"),
};

const mockSqsProducerService = {
  publish: jest.fn().mockResolvedValue(undefined),
};

const mockCustomersService = {
  findById: jest.fn().mockResolvedValue({
    id: "cust-123",
    chargeDay: 15,
    isPrepaid: true,
  }),
};

describe("InvoicesService", () => {
  let service: InvoicesService;
  let repo: jest.Mocked<InvoicesRepository>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSubscriptionsRepo.findDueForBilling.mockResolvedValue([]);

    repo = {
      findById: jest.fn().mockResolvedValue(null),
      findByIdWithLineItems: jest.fn().mockResolvedValue(null),
      findAll: jest.fn().mockResolvedValue([]),
      findPendingOnboarding: jest.fn().mockResolvedValue([]),
      findDuplicateForSubscription: jest.fn().mockResolvedValue([]),
      getLineItemsByInvoiceId: jest.fn().mockResolvedValue([]),
      getLineItemsByInvoiceIds: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(mockInvoiceRow),
      createLineItem: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({
        ...mockInvoiceRow,
        status: "finalized",
        totalAmountCents: 5000,
      }),
      updateWithConcurrencyCheck: jest.fn().mockResolvedValue(null),
      findForBillingHistory: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<InvoicesRepository>;

    const module = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: InvoicesRepository, useValue: repo },
        {
          provide: SubscriptionsRepository,
          useValue: mockSubscriptionsRepo,
        },
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
        { provide: LedgerService, useValue: mockLedgerService },
        { provide: SqsProducerService, useValue: mockSqsProducerService },
        { provide: CustomersService, useValue: mockCustomersService },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  describe("generateInvoicesForDueSubscriptions", () => {
    it("should create invoices for active subscriptions with nextBillingDate <= scheduledDate", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([]);

      const result = await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it("should calculate base_fee line item from subscription amountCents", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([]);

      await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(repo.createLineItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "base_fee",
          amountCents: 5000,
          quantity: 1,
        }),
        txMock,
      );
    });

    it("should set total_amount_cents to sum of line item amounts", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([]);

      await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(repo.update).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ totalAmountCents: 5000 }),
        txMock,
      );
    });

    it("should finalize invoice (draft→finalized) within transaction", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([]);

      await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(repo.update).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "finalized" }),
        txMock,
      );
      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it("should create ledger entry (recordInvoiceFinalized) within same transaction", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([]);

      await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(mockLedgerService.recordInvoiceFinalized).toHaveBeenCalledWith(
        expect.any(String),
        5000,
        "usd",
        "corr-123",
        txMock,
      );
    });

    it("should publish invoice.created SQS event with correct payload", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([]);

      await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "invoice.created",
        expect.objectContaining({
          customerId: "cust-123",
          totalAmountCents: 5000,
          currency: "usd",
        }),
        "corr-123",
        undefined,
      );
    });

    it("should skip subscription when a finalized invoice already exists for the period", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      // mockInvoiceRow.status === "finalized" → real duplicate, skip
      repo.findDuplicateForSubscription.mockResolvedValueOnce([mockInvoiceRow]);

      const result = await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should skip subscription when a paid invoice already exists for the period", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([
        { ...mockInvoiceRow, status: "paid" },
      ]);

      const result = await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should finalize a pre-existing recurring draft in place rather than creating a new invoice", async () => {
      const draft = {
        ...mockInvoiceRow,
        id: "draft-inv-1",
        status: "draft",
        totalAmountCents: 7500,
      };

      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([draft]);
      repo.update.mockResolvedValue({ ...draft, status: "finalized" });

      const result = await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      // Counted as created (cycle was billed), not skipped
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);

      // The existing draft id was finalized — no new invoice row was created
      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledWith(
        "draft-inv-1",
        expect.objectContaining({ status: "finalized" }),
        expect.anything(),
      );
      // Ledger entry recorded against the pre-existing draft
      expect(mockLedgerService.recordInvoiceFinalized).toHaveBeenCalledWith(
        "draft-inv-1",
        7500,
        "usd",
        "corr-123",
        expect.anything(),
      );
    });

    it("should skip with warning when only a voided invoice exists for the period (unexpected state)", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([
        { ...mockInvoiceRow, id: "void-inv", status: "void" },
      ]);

      const result = await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
      // No new invoice is created — voided state is an explicit "don't bill" signal
      expect(repo.create).not.toHaveBeenCalled();
    });

    it("should not create invoices when no subscriptions are due", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValue([]);

      const result = await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(0);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should finalize pending onboarding invoices with dueDate <= scheduledDate", async () => {
      const onboardingInvoice = {
        ...mockInvoiceRow,
        id: "onb-inv-123",
        subscriptionId: null,
        status: "draft",
        totalAmountCents: 15000,
        dueDate: new Date("2026-02-28T00:00:00.000Z"),
      };

      // No due subscriptions
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([]);
      repo.findPendingOnboarding.mockResolvedValueOnce([onboardingInvoice]);

      const result = await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(result.finalized).toBe(1);
      expect(result.created).toBe(0);
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockLedgerService.recordInvoiceFinalized).toHaveBeenCalledWith(
        "onb-inv-123",
        15000,
        "usd",
        "corr-123",
        txMock,
      );
    });

    it("should NOT finalize onboarding invoices with future dueDate", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([]);
      repo.findPendingOnboarding.mockResolvedValueOnce([]);

      const result = await service.generateInvoicesForDueSubscriptions(
        "2026-02-15",
        "corr-123",
      );

      expect(result.created).toBe(0);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should finalize onboarding invoice and trigger payment execution", async () => {
      const onboardingInvoice = {
        ...mockInvoiceRow,
        id: "onb-inv-456",
        subscriptionId: null,
        status: "draft",
        totalAmountCents: 10000,
        dueDate: new Date("2026-03-01T00:00:00.000Z"),
      };

      const mockChargesService = {
        executePaymentForInvoice: jest.fn().mockResolvedValue({
          chargeId: "charge-123",
          status: "succeeded",
          stripePaymentIntentId: "pi_123",
        }),
      };

      const { CHARGES_SERVICE } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("./invoices.service") as { CHARGES_SERVICE: symbol };

      const module = await Test.createTestingModule({
        providers: [
          InvoicesService,
          { provide: InvoicesRepository, useValue: repo },
          {
            provide: SubscriptionsRepository,
            useValue: mockSubscriptionsRepo,
          },
          { provide: DRIZZLE_PROVIDER, useValue: mockDb },
          { provide: LedgerService, useValue: mockLedgerService },
          { provide: SqsProducerService, useValue: mockSqsProducerService },
          { provide: CHARGES_SERVICE, useValue: mockChargesService },
          { provide: CustomersService, useValue: mockCustomersService },
        ],
      }).compile();

      const svcWithCharges = module.get<InvoicesService>(InvoicesService);

      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([]);
      repo.findPendingOnboarding.mockResolvedValueOnce([onboardingInvoice]);

      await svcWithCharges.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(mockChargesService.executePaymentForInvoice).toHaveBeenCalledWith(
        "onb-inv-456",
        "corr-123",
      );
    });

    it("should call advanceAndSeedNextDraft for each finalized recurring invoice regardless of charge outcome", async () => {
      const mockChargesService = {
        executePaymentForInvoice: jest.fn(),
      };
      const mockSubscriptionsAdvanceService = {
        advanceAndSeedNextDraft: jest.fn().mockResolvedValue(undefined),
      };

      const { CHARGES_SERVICE, SUBSCRIPTIONS_SERVICE_FOR_INVOICES } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("./invoices.service") as {
          CHARGES_SERVICE: symbol;
          SUBSCRIPTIONS_SERVICE_FOR_INVOICES: symbol;
        };

      const module = await Test.createTestingModule({
        providers: [
          InvoicesService,
          { provide: InvoicesRepository, useValue: repo },
          { provide: SubscriptionsRepository, useValue: mockSubscriptionsRepo },
          { provide: DRIZZLE_PROVIDER, useValue: mockDb },
          { provide: LedgerService, useValue: mockLedgerService },
          { provide: SqsProducerService, useValue: mockSqsProducerService },
          { provide: CHARGES_SERVICE, useValue: mockChargesService },
          {
            provide: SUBSCRIPTIONS_SERVICE_FOR_INVOICES,
            useValue: mockSubscriptionsAdvanceService,
          },
          { provide: CustomersService, useValue: mockCustomersService },
        ],
      }).compile();

      const svc = module.get<InvoicesService>(InvoicesService);

      // Case 1: charge succeeds
      mockChargesService.executePaymentForInvoice.mockResolvedValueOnce({
        chargeId: "c1",
        status: "succeeded",
        stripePaymentIntentId: "pi1",
      });
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([]);
      repo.create.mockResolvedValueOnce({ ...mockInvoiceRow, id: "inv-a" });
      repo.update.mockResolvedValue({ ...mockInvoiceRow, id: "inv-a" });

      await svc.generateInvoicesForDueSubscriptions("2026-03-01", "corr-1");

      // Case 2: charge pending (ACH)
      mockChargesService.executePaymentForInvoice.mockResolvedValueOnce({
        chargeId: "c2",
        status: "pending",
        stripePaymentIntentId: "pi2",
      });
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        { ...mockSubscription, id: "sub-b" },
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([]);
      repo.create.mockResolvedValueOnce({ ...mockInvoiceRow, id: "inv-b" });
      repo.update.mockResolvedValue({ ...mockInvoiceRow, id: "inv-b" });

      await svc.generateInvoicesForDueSubscriptions("2026-03-01", "corr-2");

      // Case 3: charge fails (throws)
      mockChargesService.executePaymentForInvoice.mockRejectedValueOnce(
        new Error("Card declined"),
      );
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        { ...mockSubscription, id: "sub-c" },
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([]);
      repo.create.mockResolvedValueOnce({ ...mockInvoiceRow, id: "inv-c" });
      repo.update.mockResolvedValue({ ...mockInvoiceRow, id: "inv-c" });

      await svc.generateInvoicesForDueSubscriptions("2026-03-01", "corr-3");

      // advanceAndSeedNextDraft fires for all three outcomes
      expect(
        mockSubscriptionsAdvanceService.advanceAndSeedNextDraft,
      ).toHaveBeenCalledTimes(3);
    });

    it("should swallow advanceAndSeedNextDraft errors so the scheduler batch is not broken", async () => {
      const mockChargesService = {
        executePaymentForInvoice: jest.fn().mockResolvedValue({
          chargeId: "c1",
          status: "succeeded",
          stripePaymentIntentId: "pi1",
        }),
      };
      const mockSubscriptionsAdvanceService = {
        advanceAndSeedNextDraft: jest.fn().mockRejectedValue(new Error("boom")),
      };

      const { CHARGES_SERVICE, SUBSCRIPTIONS_SERVICE_FOR_INVOICES } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("./invoices.service") as {
          CHARGES_SERVICE: symbol;
          SUBSCRIPTIONS_SERVICE_FOR_INVOICES: symbol;
        };

      const module = await Test.createTestingModule({
        providers: [
          InvoicesService,
          { provide: InvoicesRepository, useValue: repo },
          { provide: SubscriptionsRepository, useValue: mockSubscriptionsRepo },
          { provide: DRIZZLE_PROVIDER, useValue: mockDb },
          { provide: LedgerService, useValue: mockLedgerService },
          { provide: SqsProducerService, useValue: mockSqsProducerService },
          { provide: CHARGES_SERVICE, useValue: mockChargesService },
          {
            provide: SUBSCRIPTIONS_SERVICE_FOR_INVOICES,
            useValue: mockSubscriptionsAdvanceService,
          },
          { provide: CustomersService, useValue: mockCustomersService },
        ],
      }).compile();

      const svc = module.get<InvoicesService>(InvoicesService);

      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([]);
      repo.create.mockResolvedValueOnce(mockInvoiceRow);
      repo.update.mockResolvedValue(mockInvoiceRow);

      const result = await svc.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-1",
      );

      // Invoice was still counted as created despite advance failing
      expect(result.created).toBe(1);
      expect(
        mockSubscriptionsAdvanceService.advanceAndSeedNextDraft,
      ).toHaveBeenCalled();
    });

    it("should handle both subscription invoices and onboarding invoices in same run", async () => {
      const onboardingInvoice = {
        ...mockInvoiceRow,
        id: "onb-inv-789",
        subscriptionId: null,
        status: "draft",
        totalAmountCents: 8000,
        dueDate: new Date("2026-02-28T00:00:00.000Z"),
      };

      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([]);
      repo.findPendingOnboarding.mockResolvedValueOnce([onboardingInvoice]);

      const result = await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(result.created).toBe(1);
      expect(result.finalized).toBe(1);
    });

    it("should log structured messages during generation", async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, "log")
        .mockImplementation(() => {});
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValue([]);

      await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Found due subscriptions for invoice generation",
          count: 0,
          scheduledDate: "2026-03-01",
          correlationId: "corr-123",
        }),
      );

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Invoice generation completed",
          created: 0,
          skipped: 0,
          correlationId: "corr-123",
        }),
      );

      logSpy.mockRestore();
    });
  });

  describe("invoice state machine", () => {
    it("should reject invalid transition via validateTransition", () => {
      const { validateTransition } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../common/utils/state-machine.util") as {
          validateTransition: (
            current: string,
            target: string,
            transitions: Record<string, string[]>,
          ) => void;
        };
      const { INVOICE_TRANSITIONS } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("./invoice-state-machine") as {
          INVOICE_TRANSITIONS: Record<string, string[]>;
        };

      expect(() =>
        validateTransition("paid", "draft", INVOICE_TRANSITIONS),
      ).toThrow(StateTransitionException);

      expect(() =>
        validateTransition("void", "finalized", INVOICE_TRANSITIONS),
      ).toThrow(StateTransitionException);

      expect(() =>
        validateTransition("draft", "paid", INVOICE_TRANSITIONS),
      ).toThrow(StateTransitionException);
    });

    it("should allow valid transitions", () => {
      const { validateTransition } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../common/utils/state-machine.util") as {
          validateTransition: (
            current: string,
            target: string,
            transitions: Record<string, string[]>,
          ) => void;
        };
      const { INVOICE_TRANSITIONS } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("./invoice-state-machine") as {
          INVOICE_TRANSITIONS: Record<string, string[]>;
        };

      expect(() =>
        validateTransition("draft", "finalized", INVOICE_TRANSITIONS),
      ).not.toThrow();

      expect(() =>
        validateTransition("finalized", "paid", INVOICE_TRANSITIONS),
      ).not.toThrow();

      expect(() =>
        validateTransition("finalized", "void", INVOICE_TRANSITIONS),
      ).not.toThrow();
    });
  });

  describe("findById", () => {
    it("should return invoice with line items when found", async () => {
      repo.findByIdWithLineItems.mockResolvedValueOnce({
        invoice: mockInvoiceRow,
        lineItems: [mockLineItemRow],
      });

      const result = await service.findById("inv-123");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("inv-123");
      expect(result?.status).toBe("finalized");
      expect(result?.lineItems).toHaveLength(1);
      expect(result?.lineItems[0].type).toBe("base_fee");
      expect(result?.billingPeriodStart).toBe("2026-03-01T00:00:00.000Z");
    });

    it("should return null when invoice not found", async () => {
      repo.findByIdWithLineItems.mockResolvedValueOnce(null);

      const result = await service.findById("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("findAll", () => {
    it("should return paginated invoices with line items", async () => {
      repo.findAll.mockResolvedValueOnce([mockInvoiceRow]);
      repo.getLineItemsByInvoiceIds.mockResolvedValueOnce([mockLineItemRow]);

      const result = await service.findAll({});

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe("inv-123");
      expect(result.data[0].lineItems).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
    });

    it("should filter by customerId", async () => {
      repo.findAll.mockResolvedValueOnce([]);

      await service.findAll({ customerId: "cust-123" });

      expect(repo.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: "cust-123" }),
        20,
      );
    });

    it("should filter by status", async () => {
      repo.findAll.mockResolvedValueOnce([]);

      await service.findAll({ status: "finalized" });

      expect(repo.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ status: "finalized" }),
        20,
      );
    });

    it("should return paginated results with cursor", async () => {
      repo.findAll.mockResolvedValueOnce([
        mockInvoiceRow,
        { ...mockInvoiceRow, id: "inv-456" },
      ]);
      repo.getLineItemsByInvoiceIds.mockResolvedValueOnce([mockLineItemRow]);

      const result = await service.findAll({ limit: 1 });

      expect(result.data).toHaveLength(1);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe("inv-123");
    });

    it("should handle empty results", async () => {
      repo.findAll.mockResolvedValueOnce([]);

      const result = await service.findAll({});

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it("should apply filter when startDate is provided", async () => {
      repo.findAll.mockResolvedValueOnce([]);

      await service.findAll({ startDate: "2026-03-01" });

      expect(repo.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: "2026-03-01" }),
        20,
      );
    });

    it("should apply filter when endDate is provided", async () => {
      repo.findAll.mockResolvedValueOnce([]);

      await service.findAll({ endDate: "2026-04-01" });

      expect(repo.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ endDate: "2026-04-01" }),
        20,
      );
    });
  });

  describe("voidInvoice", () => {
    it("should void a finalized invoice and return response with line items", async () => {
      const finalizedInvoice = { ...mockInvoiceRow, status: "finalized" };
      repo.findById.mockResolvedValueOnce(finalizedInvoice);
      repo.updateWithConcurrencyCheck.mockResolvedValueOnce({
        ...mockInvoiceRow,
        status: "void",
        voidedAt: new Date(),
        updatedAt: new Date(),
      });
      repo.getLineItemsByInvoiceId.mockResolvedValueOnce([mockLineItemRow]);

      const result = await service.voidInvoice("inv-123", "corr-void-1");

      expect(result.id).toBe("inv-123");
      expect(result.status).toBe("void");
      expect(result.voidedAt).toBeDefined();
      expect(result.lineItems).toHaveLength(1);
      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it("should call ledgerService.recordInvoiceVoided within transaction", async () => {
      const finalizedInvoice = { ...mockInvoiceRow, status: "finalized" };
      repo.findById.mockResolvedValueOnce(finalizedInvoice);
      repo.updateWithConcurrencyCheck.mockResolvedValueOnce({
        ...mockInvoiceRow,
        status: "void",
        voidedAt: new Date(),
        updatedAt: new Date(),
      });
      repo.getLineItemsByInvoiceId.mockResolvedValueOnce([mockLineItemRow]);

      await service.voidInvoice("inv-123", "corr-void-2");

      expect(mockLedgerService.recordInvoiceVoided).toHaveBeenCalledWith(
        "inv-123",
        5000,
        "usd",
        "corr-void-2",
        txMock,
      );
    });

    it("should throw InvoiceNotFoundException when invoice not found", async () => {
      repo.findById.mockResolvedValueOnce(null);

      await expect(
        service.voidInvoice("non-existent", "corr-void-3"),
      ).rejects.toThrow(InvoiceNotFoundException);
    });

    it("should throw InvoiceAlreadyPaidException when invoice is paid", async () => {
      repo.findById.mockResolvedValueOnce({
        ...mockInvoiceRow,
        status: "paid",
        paidAt: new Date(),
      });

      await expect(
        service.voidInvoice("inv-123", "corr-void-4"),
      ).rejects.toThrow(InvoiceAlreadyPaidException);
    });

    it("should throw InvoiceNotFinalizedException when invoice is draft", async () => {
      repo.findById.mockResolvedValueOnce({
        ...mockInvoiceRow,
        status: "draft",
      });

      await expect(
        service.voidInvoice("inv-123", "corr-void-5"),
      ).rejects.toThrow(InvoiceNotFinalizedException);
    });

    it("should throw InvoiceAlreadyVoidedException when invoice is already void", async () => {
      repo.findById.mockResolvedValueOnce({
        ...mockInvoiceRow,
        status: "void",
        voidedAt: new Date(),
      });

      await expect(
        service.voidInvoice("inv-123", "corr-void-6"),
      ).rejects.toThrow(InvoiceAlreadyVoidedException);
    });

    it("should set voidedAt timestamp on void", async () => {
      const finalizedInvoice = { ...mockInvoiceRow, status: "finalized" };
      repo.findById.mockResolvedValueOnce(finalizedInvoice);
      const voidedAt = new Date();
      repo.updateWithConcurrencyCheck.mockResolvedValueOnce({
        ...mockInvoiceRow,
        status: "void",
        voidedAt,
        updatedAt: voidedAt,
      });
      repo.getLineItemsByInvoiceId.mockResolvedValueOnce([mockLineItemRow]);

      const result = await service.voidInvoice("inv-123", "corr-void-7");

      expect(result.voidedAt).not.toBeNull();
      expect(repo.updateWithConcurrencyCheck).toHaveBeenCalledWith(
        "inv-123",
        expect.objectContaining({
          status: "void",
          voidedAt: expect.any(Date),
        }),
        "finalized",
        txMock,
      );
    });
  });

  describe("credit application during invoice generation", () => {
    let serviceWithCredits: InvoicesService;
    let mockCreditsService: { applyCreditsToInvoice: jest.Mock };

    beforeEach(async () => {
      jest.clearAllMocks();
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValue([]);

      repo.create.mockResolvedValue(mockInvoiceRow);
      repo.update.mockResolvedValue({
        ...mockInvoiceRow,
        status: "finalized",
        totalAmountCents: 5000,
      });
      repo.findPendingOnboarding.mockResolvedValue([]);
      repo.findDuplicateForSubscription.mockResolvedValue([]);

      mockCreditsService = {
        applyCreditsToInvoice: jest
          .fn()
          .mockResolvedValue({ creditApplied: 0, newTotal: 5000 }),
      };

      const module = await Test.createTestingModule({
        providers: [
          InvoicesService,
          { provide: InvoicesRepository, useValue: repo },
          {
            provide: SubscriptionsRepository,
            useValue: mockSubscriptionsRepo,
          },
          { provide: DRIZZLE_PROVIDER, useValue: mockDb },
          { provide: LedgerService, useValue: mockLedgerService },
          { provide: SqsProducerService, useValue: mockSqsProducerService },
          { provide: CreditsService, useValue: mockCreditsService },
          { provide: CustomersService, useValue: mockCustomersService },
        ],
      }).compile();

      serviceWithCredits = module.get<InvoicesService>(InvoicesService);
    });

    it("should call applyCreditsToInvoice within transaction for subscription invoices", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);

      await serviceWithCredits.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-credit-1",
      );

      expect(mockCreditsService.applyCreditsToInvoice).toHaveBeenCalledWith(
        expect.any(String),
        "cust-123",
        5000,
        "usd",
        "corr-credit-1",
        txMock,
      );
    });

    it("should publish invoice.created and proceed to payment when no credits applied", async () => {
      mockCreditsService.applyCreditsToInvoice.mockResolvedValue({
        creditApplied: 0,
        newTotal: 5000,
      });

      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);

      await serviceWithCredits.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-credit-2",
      );

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "invoice.created",
        expect.objectContaining({
          totalAmountCents: 5000,
        }),
        "corr-credit-2",
        undefined,
      );
    });

    it("should publish invoice.created with reduced amount when partial credits applied", async () => {
      mockCreditsService.applyCreditsToInvoice.mockResolvedValue({
        creditApplied: 3000,
        newTotal: 2000,
      });

      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);

      await serviceWithCredits.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-credit-3",
      );

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "invoice.created",
        expect.objectContaining({
          totalAmountCents: 2000,
        }),
        "corr-credit-3",
        undefined,
      );
    });

    it("should publish invoice.paid and skip payment when fully covered by credits", async () => {
      mockCreditsService.applyCreditsToInvoice.mockResolvedValue({
        creditApplied: 5000,
        newTotal: 0,
      });

      const mockChargesService = {
        executePaymentForInvoice: jest.fn().mockResolvedValue(undefined),
      };

      const { CHARGES_SERVICE } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("./invoices.service") as { CHARGES_SERVICE: symbol };

      const module = await Test.createTestingModule({
        providers: [
          InvoicesService,
          { provide: InvoicesRepository, useValue: repo },
          {
            provide: SubscriptionsRepository,
            useValue: mockSubscriptionsRepo,
          },
          { provide: DRIZZLE_PROVIDER, useValue: mockDb },
          { provide: LedgerService, useValue: mockLedgerService },
          { provide: SqsProducerService, useValue: mockSqsProducerService },
          { provide: CreditsService, useValue: mockCreditsService },
          { provide: CHARGES_SERVICE, useValue: mockChargesService },
          { provide: CustomersService, useValue: mockCustomersService },
        ],
      }).compile();

      const svc = module.get<InvoicesService>(InvoicesService);

      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);

      await svc.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-credit-4",
      );

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "invoice.paid",
        expect.objectContaining({
          totalAmountCents: 0,
          paidAt: expect.any(String),
        }),
        "corr-credit-4",
        undefined,
      );

      const publishCall = mockSqsProducerService.publish.mock.calls.find(
        (c: unknown[]) => c[0] === "invoice.paid",
      ) as unknown[];
      const payload = publishCall[1] as Record<string, unknown>;
      expect(payload).not.toHaveProperty("creditApplied");
      expect(payload).not.toHaveProperty("subscriptionId");
      expect(payload).toHaveProperty("paidAt");

      expect(
        mockChargesService.executePaymentForInvoice,
      ).not.toHaveBeenCalled();
    });

    it("should work normally without creditsService injected (Optional)", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([]);

      const result = await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-credit-5",
      );

      expect(result.created).toBe(1);
      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "invoice.created",
        expect.objectContaining({
          totalAmountCents: 5000,
        }),
        "corr-credit-5",
        undefined,
      );
    });

    it("should apply credits to onboarding invoices", async () => {
      const onboardingInvoice = {
        ...mockInvoiceRow,
        id: "onb-inv-credit",
        subscriptionId: null,
        status: "draft",
        totalAmountCents: 10000,
        dueDate: new Date("2026-02-28T00:00:00.000Z"),
      };

      mockCreditsService.applyCreditsToInvoice.mockResolvedValue({
        creditApplied: 4000,
        newTotal: 6000,
      });

      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([]);
      repo.findPendingOnboarding.mockResolvedValueOnce([onboardingInvoice]);

      const result =
        await serviceWithCredits.generateInvoicesForDueSubscriptions(
          "2026-03-01",
          "corr-credit-6",
        );

      expect(result.finalized).toBe(1);
      expect(mockCreditsService.applyCreditsToInvoice).toHaveBeenCalledWith(
        "onb-inv-credit",
        "cust-123",
        10000,
        "usd",
        "corr-credit-6",
        txMock,
      );
    });

    it("should publish invoice.paid and skip payment for fully covered onboarding invoice", async () => {
      const onboardingInvoice = {
        ...mockInvoiceRow,
        id: "onb-inv-full",
        subscriptionId: null,
        status: "draft",
        totalAmountCents: 5000,
        dueDate: new Date("2026-02-28T00:00:00.000Z"),
      };

      mockCreditsService.applyCreditsToInvoice.mockResolvedValue({
        creditApplied: 5000,
        newTotal: 0,
      });

      const mockChargesService = {
        executePaymentForInvoice: jest.fn().mockResolvedValue(undefined),
      };

      const { CHARGES_SERVICE } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("./invoices.service") as { CHARGES_SERVICE: symbol };

      const module = await Test.createTestingModule({
        providers: [
          InvoicesService,
          { provide: InvoicesRepository, useValue: repo },
          {
            provide: SubscriptionsRepository,
            useValue: mockSubscriptionsRepo,
          },
          { provide: DRIZZLE_PROVIDER, useValue: mockDb },
          { provide: LedgerService, useValue: mockLedgerService },
          { provide: SqsProducerService, useValue: mockSqsProducerService },
          { provide: CreditsService, useValue: mockCreditsService },
          { provide: CHARGES_SERVICE, useValue: mockChargesService },
          { provide: CustomersService, useValue: mockCustomersService },
        ],
      }).compile();

      const svc = module.get<InvoicesService>(InvoicesService);

      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([]);
      repo.findPendingOnboarding.mockResolvedValueOnce([onboardingInvoice]);

      await svc.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-credit-7",
      );

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "invoice.paid",
        expect.objectContaining({
          invoiceId: "onb-inv-full",
          totalAmountCents: 0,
          paidAt: expect.any(String),
        }),
        "corr-credit-7",
        undefined,
      );

      const publishCall = mockSqsProducerService.publish.mock.calls.find(
        (c: unknown[]) => c[0] === "invoice.paid",
      ) as unknown[];
      const payload = publishCall[1] as Record<string, unknown>;
      expect(payload).not.toHaveProperty("creditApplied");
      expect(payload).toHaveProperty("paidAt");

      expect(
        mockChargesService.executePaymentForInvoice,
      ).not.toHaveBeenCalled();
    });
  });

  describe("voidDraftInvoicesForCustomer", () => {
    it("should void a draft invoice and return 1", async () => {
      const draftInvoice = {
        ...mockInvoiceRow,
        id: "inv-draft-1",
        status: "draft",
      };
      (repo as unknown as Record<string, jest.Mock>).findDraftByCustomerId =
        jest.fn().mockResolvedValue(draftInvoice);

      const count = await service.voidDraftInvoicesForCustomer(
        "cust-123",
        "corr-void-draft-1",
      );

      expect(count).toBe(1);
      expect(repo.update).toHaveBeenCalledWith(
        "inv-draft-1",
        expect.objectContaining({
          status: "void",
          voidedAt: expect.any(Date),
          updatedAt: expect.any(Date),
        }),
      );
    });

    it("should return 0 when no draft invoice exists", async () => {
      (repo as unknown as Record<string, jest.Mock>).findDraftByCustomerId =
        jest.fn().mockResolvedValue(null);

      const count = await service.voidDraftInvoicesForCustomer(
        "cust-123",
        "corr-void-draft-2",
      );

      expect(count).toBe(0);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("should NOT void finalized invoices (uses findDraftByCustomerId, not findOpenRecurringDraft)", async () => {
      // Simulate: only finalized invoices exist -> findDraftByCustomerId returns null
      (repo as unknown as Record<string, jest.Mock>).findDraftByCustomerId =
        jest.fn().mockResolvedValue(null);

      const count = await service.voidDraftInvoicesForCustomer(
        "cust-123",
        "corr-void-draft-3",
      );

      expect(count).toBe(0);
      // Verify it called findDraftByCustomerId (not findOpenRecurringDraft)
      expect(
        (repo as unknown as Record<string, jest.Mock>).findDraftByCustomerId,
      ).toHaveBeenCalledWith("cust-123");
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("should call findDraftByCustomerId on the repository", async () => {
      (repo as unknown as Record<string, jest.Mock>).findDraftByCustomerId =
        jest.fn().mockResolvedValue(null);

      await service.voidDraftInvoicesForCustomer("cust-456");

      expect(
        (repo as unknown as Record<string, jest.Mock>).findDraftByCustomerId,
      ).toHaveBeenCalledWith("cust-456");
    });

    it("should log structured message when draft invoice is voided", async () => {
      const draftInvoice = {
        ...mockInvoiceRow,
        id: "inv-draft-log",
        status: "draft",
      };
      (repo as unknown as Record<string, jest.Mock>).findDraftByCustomerId =
        jest.fn().mockResolvedValue(draftInvoice);

      const logSpy = jest
        .spyOn(Logger.prototype, "log")
        .mockImplementation(() => {});

      await service.voidDraftInvoicesForCustomer("cust-123", "corr-void-log");

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Draft invoice voided on subscription pause/cancel",
          invoiceId: "inv-draft-log",
          customerId: "cust-123",
          correlationId: "corr-void-log",
        }),
      );

      logSpy.mockRestore();
    });
  });
});

// --- Surcharge Tests ---

const mockSurchargeConfig = {
  getConfig: jest.fn(),
};

const mockPaymentMethodsService = {
  getDefaultPaymentMethod: jest.fn(),
};

const mockOpenInvoice = {
  id: "inv-open-1",
  customerId: "cust-123",
  subscriptionId: "sub-123",
  type: "recurring",
  status: "draft",
  totalAmountCents: 500000,
  currency: "usd",
  billingPeriodStart: new Date("2026-03-01"),
  billingPeriodEnd: new Date("2026-04-01"),
  dueDate: new Date("2026-04-01"),
  paidAt: null,
  voidedAt: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockEmployeeLineItem = {
  id: "li-emp-1",
  invoiceId: "inv-open-1",
  type: "employee_cost",
  description: "John Doe",
  amountCents: 500000,
  quantity: 1,
  breakdown: null,
  createdAt: new Date(),
};

describe("InvoicesService - Surcharge", () => {
  let service: InvoicesService;
  let repo: jest.Mocked<InvoicesRepository>;
  const txMock2 = { id: "tx-surcharge" };
  const mockDb2 = {
    transaction: jest.fn((cb: (tx: typeof txMock2) => Promise<unknown>) =>
      cb(txMock2),
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    repo = {
      findById: jest.fn(),
      findByIdWithLineItems: jest.fn(),
      findAll: jest.fn(),
      findPendingOnboarding: jest.fn(),
      findDuplicateForSubscription: jest.fn().mockResolvedValue([]),
      getLineItemsByInvoiceId: jest.fn().mockResolvedValue([]),
      getLineItemsByInvoiceIds: jest.fn(),
      create: jest.fn().mockResolvedValue(mockInvoiceRow),
      createLineItem: jest.fn(),
      createLineItems: jest.fn(),
      update: jest
        .fn()
        .mockResolvedValue({ ...mockInvoiceRow, status: "finalized" }),
      updateWithConcurrencyCheck: jest.fn(),
      deleteLineItemsByInvoiceId: jest.fn(),
      deleteLineItemsByInvoiceIdAndType: jest.fn(),
      findOpenRecurringDraft: jest.fn(),
      countOpenRecurringDrafts: jest.fn().mockResolvedValue(1),
      findForBillingHistory: jest.fn(),
    } as unknown as jest.Mocked<InvoicesRepository>;

    const module = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: InvoicesRepository, useValue: repo },
        {
          provide: SubscriptionsRepository,
          useValue: { findDueForBilling: jest.fn().mockResolvedValue([]) },
        },
        { provide: DRIZZLE_PROVIDER, useValue: mockDb2 },
        {
          provide: LedgerService,
          useValue: {
            recordInvoiceFinalized: jest.fn(),
            recordInvoiceVoided: jest.fn(),
          },
        },
        { provide: SqsProducerService, useValue: { publish: jest.fn() } },
        {
          provide: CustomersService,
          useValue: {
            findById: jest.fn().mockResolvedValue({
              id: "cust-123",
              chargeDay: 15,
              isPrepaid: true,
            }),
          },
        },
        { provide: SurchargeConfigService, useValue: mockSurchargeConfig },
        { provide: PaymentMethodsService, useValue: mockPaymentMethodsService },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  describe("createDraftInvoice with surcharge", () => {
    const draftParams = {
      customerId: "cust-123",
      subscriptionId: null,
      type: "one_time" as const,
      lineItems: [
        {
          type: "one_time_charge",
          description: "Setup Fee",
          amountCents: 100000,
          quantity: 1,
        },
      ],
      totalAmountCents: 100000,
      currency: "usd",
      billingPeriodStart: new Date(),
      billingPeriodEnd: new Date(),
      dueDate: new Date(),
    };

    it("should add surcharge line item for card PM with percentage config", async () => {
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue({
        type: "card",
      });
      mockSurchargeConfig.getConfig.mockResolvedValue({
        surchargeType: "percentage",
        surchargeValue: 3,
      });

      await service.createDraftInvoice(draftParams, "corr-1");

      // Invoice created with adjusted total: 100000 + 3% = 103000
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmountCents: 103000 }),
        txMock2,
      );
      // Line items include surcharge
      expect(repo.createLineItems).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            type: "surcharge",
            amountCents: 3000,
            description: "Credit card surcharge",
          }),
        ]),
        txMock2,
      );
    });

    it("should add flat fee surcharge (value in dollars, converted to cents)", async () => {
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue({
        type: "card",
      });
      mockSurchargeConfig.getConfig.mockResolvedValue({
        surchargeType: "flat_fee",
        surchargeValue: 10,
      });

      await service.createDraftInvoice(draftParams, "corr-2");

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmountCents: 101000 }),
        txMock2,
      );
      expect(repo.createLineItems).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ type: "surcharge", amountCents: 1000 }),
        ]),
        txMock2,
      );
    });

    it("should NOT add surcharge for ACH payment method", async () => {
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue({
        type: "bank_account",
      });
      mockSurchargeConfig.getConfig.mockResolvedValue({
        surchargeType: "percentage",
        surchargeValue: 3,
      });

      await service.createDraftInvoice(draftParams, "corr-3");

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmountCents: 100000 }),
        txMock2,
      );
    });

    it("should NOT add surcharge when no PM is set", async () => {
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue(null);

      await service.createDraftInvoice(draftParams, "corr-4");

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmountCents: 100000 }),
        txMock2,
      );
    });

    it("should NOT add surcharge when no surcharge config exists", async () => {
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue({
        type: "card",
      });
      mockSurchargeConfig.getConfig.mockResolvedValue(null);

      await service.createDraftInvoice(draftParams, "corr-5");

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmountCents: 100000 }),
        txMock2,
      );
    });

    it("should NOT add surcharge when surchargeValue is 0", async () => {
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue({
        type: "card",
      });
      mockSurchargeConfig.getConfig.mockResolvedValue({
        surchargeType: "percentage",
        surchargeValue: 0,
      });

      await service.createDraftInvoice(draftParams, "corr-6");

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmountCents: 100000 }),
        txMock2,
      );
    });
  });

  describe("recalculateSurchargeOnOpenInvoice", () => {
    it("should add surcharge when config changes and card PM is default", async () => {
      repo.findOpenRecurringDraft.mockResolvedValue(mockOpenInvoice as any);
      repo.getLineItemsByInvoiceId.mockResolvedValue([
        mockEmployeeLineItem as any,
      ]);
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue({
        type: "card",
      });
      mockSurchargeConfig.getConfig.mockResolvedValue({
        surchargeType: "percentage",
        surchargeValue: 3,
      });

      await service.recalculateSurchargeOnOpenInvoice(
        "cust-123",
        "corr-reCalc",
      );

      expect(repo.deleteLineItemsByInvoiceIdAndType).toHaveBeenCalledWith(
        "inv-open-1",
        "surcharge",
        txMock2,
      );
      expect(repo.createLineItem).toHaveBeenCalledWith(
        expect.objectContaining({ type: "surcharge", amountCents: 15000 }),
        txMock2,
      );
      expect(repo.update).toHaveBeenCalledWith(
        "inv-open-1",
        expect.objectContaining({ totalAmountCents: 515000 }),
        txMock2,
      );
    });

    it("should remove surcharge when PM switches to ACH", async () => {
      repo.findOpenRecurringDraft.mockResolvedValue(mockOpenInvoice as any);
      repo.getLineItemsByInvoiceId.mockResolvedValue([
        mockEmployeeLineItem as any,
        {
          ...mockEmployeeLineItem,
          id: "li-sur-1",
          type: "surcharge",
          description: "Credit card surcharge",
          amountCents: 15000,
        },
      ] as any);
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue({
        type: "bank_account",
      });

      await service.recalculateSurchargeOnOpenInvoice(
        "cust-123",
        "corr-pm-ach",
      );

      expect(repo.deleteLineItemsByInvoiceIdAndType).toHaveBeenCalledWith(
        "inv-open-1",
        "surcharge",
        txMock2,
      );
      expect(repo.createLineItem).not.toHaveBeenCalled();
      // Total should be subtotal only (no surcharge)
      expect(repo.update).toHaveBeenCalledWith(
        "inv-open-1",
        expect.objectContaining({ totalAmountCents: 500000 }),
        txMock2,
      );
    });

    it("should no-op when no open invoice exists", async () => {
      repo.findOpenRecurringDraft.mockResolvedValue(null);

      await service.recalculateSurchargeOnOpenInvoice("cust-123", "corr-noop");

      expect(repo.deleteLineItemsByInvoiceIdAndType).not.toHaveBeenCalled();
      expect(repo.createLineItem).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("should recalculate surcharge from non-surcharge items only", async () => {
      const existingSurcharge = {
        ...mockEmployeeLineItem,
        id: "li-sur-old",
        type: "surcharge",
        amountCents: 10000,
      };
      repo.findOpenRecurringDraft.mockResolvedValue(mockOpenInvoice as any);
      repo.getLineItemsByInvoiceId.mockResolvedValue([
        mockEmployeeLineItem as any,
        existingSurcharge as any,
      ]);
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue({
        type: "card",
      });
      mockSurchargeConfig.getConfig.mockResolvedValue({
        surchargeType: "percentage",
        surchargeValue: 3,
      });

      await service.recalculateSurchargeOnOpenInvoice(
        "cust-123",
        "corr-recalc",
      );

      // Subtotal should be 500000 (employee only, old surcharge excluded)
      expect(repo.createLineItem).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 15000 }),
        txMock2,
      );
      expect(repo.update).toHaveBeenCalledWith(
        "inv-open-1",
        expect.objectContaining({ totalAmountCents: 515000 }),
        txMock2,
      );
    });
  });

  describe("updateOpenInvoiceLineItems with surcharge", () => {
    const employees = [
      {
        employeeId: "emp-1",
        employeeName: "John Doe",
        customerCost: 300000,
        salary: 250000,
        platformFee: 50000,
        bonus: 0,
        raise: 0,
        discount: 0,
      },
      {
        employeeId: "emp-2",
        employeeName: "Jane Smith",
        customerCost: 200000,
        salary: 170000,
        platformFee: 30000,
        bonus: 0,
        raise: 0,
        discount: 0,
      },
    ];

    it("should include surcharge line item when card PM + config", async () => {
      repo.findOpenRecurringDraft.mockResolvedValue(mockOpenInvoice as any);
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue({
        type: "card",
      });
      mockSurchargeConfig.getConfig.mockResolvedValue({
        surchargeType: "percentage",
        surchargeValue: 3,
      });

      await service.updateOpenInvoiceLineItems(
        "cust-123",
        employees,
        500000,
        "corr-upd",
      );

      // Should create 3 line items: 2 employees + 1 surcharge
      expect(repo.createLineItems).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            type: "employee_cost",
            description: "John Doe",
          }),
          expect.objectContaining({
            type: "employee_cost",
            description: "Jane Smith",
          }),
          expect.objectContaining({ type: "surcharge", amountCents: 15000 }),
        ]),
        txMock2,
      );
      // Total = 500000 + 15000
      expect(repo.update).toHaveBeenCalledWith(
        "inv-open-1",
        expect.objectContaining({ totalAmountCents: 515000 }),
        txMock2,
      );
    });

    it("should NOT include surcharge when ACH PM", async () => {
      repo.findOpenRecurringDraft.mockResolvedValue(mockOpenInvoice as any);
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue({
        type: "bank_account",
      });
      mockSurchargeConfig.getConfig.mockResolvedValue({
        surchargeType: "percentage",
        surchargeValue: 3,
      });

      await service.updateOpenInvoiceLineItems(
        "cust-123",
        employees,
        500000,
        "corr-upd-ach",
      );

      // Should create 2 line items: employees only
      expect(repo.createLineItems).toHaveBeenCalledWith(
        expect.not.arrayContaining([
          expect.objectContaining({ type: "surcharge" }),
        ]),
        txMock2,
      );
      expect(repo.update).toHaveBeenCalledWith(
        "inv-open-1",
        expect.objectContaining({ totalAmountCents: 500000 }),
        txMock2,
      );
    });

    it("no-op + WARN when no open recurring draft exists (e.g., mid-onboarding)", async () => {
      repo.findOpenRecurringDraft.mockResolvedValue(null);
      const warnSpy = jest.spyOn(service["logger"], "warn");

      await service.updateOpenInvoiceLineItems(
        "cust-no-draft",
        employees,
        500000,
        "corr-noop",
      );

      expect(repo.deleteLineItemsByInvoiceId).not.toHaveBeenCalled();
      expect(repo.createLineItems).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/no open recurring draft/i),
          customerId: "cust-no-draft",
        }),
      );
    });

    it("refuses to mutate if repository contract leaks a non-recurring or non-draft invoice", async () => {
      // Simulate a hypothetical repository regression returning a finalized onboarding invoice.
      repo.findOpenRecurringDraft.mockResolvedValue({
        ...mockOpenInvoice,
        type: "onboarding",
        status: "finalized",
      } as any);
      const errorSpy = jest.spyOn(service["logger"], "error");

      await service.updateOpenInvoiceLineItems(
        "cust-123",
        employees,
        500000,
        "corr-guard",
      );

      expect(repo.deleteLineItemsByInvoiceId).not.toHaveBeenCalled();
      expect(repo.createLineItems).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/not a recurring draft/i),
          invoiceStatus: "finalized",
          invoiceType: "onboarding",
        }),
      );
    });

    it("fails closed: logs ERROR and refuses to mutate when more than one open recurring draft exists", async () => {
      repo.findOpenRecurringDraft.mockResolvedValue(mockOpenInvoice as any);
      repo.countOpenRecurringDrafts.mockResolvedValue(2);
      mockPaymentMethodsService.getDefaultPaymentMethod.mockResolvedValue({
        type: "bank_account",
      });
      mockSurchargeConfig.getConfig.mockResolvedValue({});
      const errorSpy = jest.spyOn(service["logger"], "error");

      await service.updateOpenInvoiceLineItems(
        "cust-123",
        employees,
        500000,
        "corr-multi",
      );

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/refusing to mutate/i),
          draftCount: 2,
        }),
      );
      // No DB writes — operator must resolve duplicates first.
      expect(repo.deleteLineItemsByInvoiceId).not.toHaveBeenCalled();
      expect(repo.createLineItems).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });
  });
});
