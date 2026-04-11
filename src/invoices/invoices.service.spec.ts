import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvoicesService } from "./invoices.service";
import { InvoicesRepository } from "./invoices.repository";
import { SubscriptionsRepository } from "../subscriptions/subscriptions.repository";
import { LedgerService } from "../ledger/ledger.service";
import { CreditsService } from "../credits/credits.service";
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

    it("should skip subscription already invoiced for current billing period", async () => {
      mockSubscriptionsRepo.findDueForBilling.mockResolvedValueOnce([
        mockSubscription,
      ]);
      repo.findDuplicateForSubscription.mockResolvedValueOnce([mockInvoiceRow]);

      const result = await service.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "corr-123",
      );

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockDb.transaction).not.toHaveBeenCalled();
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
});
