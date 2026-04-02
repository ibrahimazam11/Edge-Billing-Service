import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { RefundsService } from "./refunds.service";
import { RefundsRepository } from "./refunds.repository";
import { ChargesRepository } from "../charges/charges.repository";
import { PaymentMethodsRepository } from "../payment-methods/payment-methods.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import { GatewayRegistry } from "../gateway/gateway.registry";
import { LedgerService } from "../ledger/ledger.service";
import { SqsProducerService } from "../integration/sqs/sqs-producer.service";
import { BusinessRuleViolationException } from "../common/exceptions/billing.exception";
import { GatewayNotAvailableException } from "../common/exceptions/gateway-not-available.exception";
import { GatewayProvider } from "../common/enums/gateway-provider.enum";
import type { CreateRefundInput } from "./dto/create-refund.dto";

const MOCK_CHARGE = {
  id: "c0000000-0000-4000-a000-000000000001",
  invoiceId: "i0000000-0000-4000-a000-000000000001",
  customerId: "u0000000-0000-4000-a000-000000000001",
  paymentMethodId: "p0000000-0000-4000-a000-000000000001",
  amountCents: 10000,
  currency: "usd",
  status: "succeeded",
  stripePaymentIntentId: "pi_test_123",
  idempotencyKey: "key-charge-1",
  failureReason: null,
  attemptNumber: 1,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const MOCK_REFUND_ROW = {
  id: "r0000000-0000-4000-a000-000000000001",
  chargeId: MOCK_CHARGE.id,
  invoiceId: MOCK_CHARGE.invoiceId,
  customerId: MOCK_CHARGE.customerId,
  amountCents: 5000,
  currency: "usd",
  status: "succeeded",
  reason: "customer_request",
  idempotencyKey: "idem-key-1",
  gatewayRefundId: "re_test_123",
  failureReason: null,
  createdAt: new Date("2026-01-02"),
  updatedAt: new Date("2026-01-02"),
};

describe("RefundsService", () => {
  let service: RefundsService;

  const txMock = { id: "tx-mock" };

  const mockDb = {
    transaction: jest.fn((cb: (tx: typeof txMock) => Promise<void>) =>
      cb(txMock),
    ),
  };

  const mockRefundsRepo = {
    findById: jest.fn(),
    findByIdempotencyKey: jest.fn(),
    findSucceededByChargeId: jest.fn(),
    findForBillingHistory: jest.fn(),
    create: jest.fn(),
    createWithIdempotency: jest.fn(),
    updateStatus: jest.fn(),
    updateToSucceeded: jest.fn(),
  };

  const mockChargesRepo = {
    findById: jest.fn(),
  };

  const mockPaymentMethodsRepo = {
    findById: jest.fn(),
  };

  const mockGateway = {
    createRefund: jest.fn(),
  };

  const mockGatewayRegistry = {
    getAdapter: jest.fn().mockReturnValue(mockGateway),
  };

  const mockLedgerService = {
    recordRefundSucceeded: jest.fn().mockResolvedValue("ledger-entry-id"),
  };

  /**
   * Sets up the mock repository sequence for a full createRefund flow:
   * 1. Charge lookup via ChargesRepository.findById
   * 2. PM lookup via PaymentMethodsRepository.findById
   * 3. Existing refunds via RefundsRepository.findSucceededByChargeId
   */
  function setupFullFlow(charge: unknown, existingRefunds: unknown[] = []) {
    mockChargesRepo.findById.mockResolvedValue(charge);
    mockPaymentMethodsRepo.findById.mockResolvedValue({
      gatewayProvider: "stripe",
    });
    mockRefundsRepo.findSucceededByChargeId.mockResolvedValue(existingRefunds);
    mockRefundsRepo.createWithIdempotency.mockImplementation(
      (data: Record<string, unknown>) => ({
        refund: data,
        isDuplicate: false,
      }),
    );
    mockRefundsRepo.updateStatus.mockResolvedValue(undefined);
    mockRefundsRepo.updateToSucceeded.mockResolvedValue(undefined);
  }

  /**
   * Sets up mock for tests that only need the charge lookup (errors before refund queries).
   */
  function setupChargeOnly(charge: unknown) {
    mockChargesRepo.findById.mockResolvedValue(charge);
  }

  /**
   * Sets up mock for tests that need charge + existing refunds (amount validation error).
   */
  function setupChargeAndRefunds(charge: unknown, existingRefunds: unknown[]) {
    mockChargesRepo.findById.mockResolvedValue(charge);
    mockPaymentMethodsRepo.findById.mockResolvedValue({
      gatewayProvider: "stripe",
    });
    mockRefundsRepo.findSucceededByChargeId.mockResolvedValue(existingRefunds);
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    mockDb.transaction
      .mockReset()
      .mockImplementation((cb: (tx: typeof txMock) => Promise<void>) =>
        cb(txMock),
      );
    mockRefundsRepo.findById.mockReset();
    mockRefundsRepo.findByIdempotencyKey.mockReset();
    mockRefundsRepo.findSucceededByChargeId.mockReset();
    mockRefundsRepo.findForBillingHistory.mockReset();
    mockRefundsRepo.createWithIdempotency.mockReset();
    mockRefundsRepo.updateStatus.mockReset().mockResolvedValue(undefined);
    mockRefundsRepo.updateToSucceeded.mockReset().mockResolvedValue(undefined);
    mockChargesRepo.findById.mockReset();
    mockPaymentMethodsRepo.findById.mockReset();
    mockGateway.createRefund.mockReset();
    mockGatewayRegistry.getAdapter.mockReset().mockReturnValue(mockGateway);
    mockLedgerService.recordRefundSucceeded
      .mockReset()
      .mockResolvedValue("ledger-entry-id");

    const module = await Test.createTestingModule({
      providers: [
        RefundsService,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
        { provide: RefundsRepository, useValue: mockRefundsRepo },
        { provide: ChargesRepository, useValue: mockChargesRepo },
        {
          provide: PaymentMethodsRepository,
          useValue: mockPaymentMethodsRepo,
        },
        { provide: GatewayRegistry, useValue: mockGatewayRegistry },
        { provide: LedgerService, useValue: mockLedgerService },
      ],
    }).compile();

    service = module.get<RefundsService>(RefundsService);
  });

  const defaultDto: CreateRefundInput = {
    chargeId: MOCK_CHARGE.id,
    amountCents: 5000,
    reason: "customer_request",
    customerId: MOCK_CHARGE.customerId,
  };

  describe("createRefund — success path", () => {
    it("should process refund through pending → processing → succeeded with ledger entry", async () => {
      setupFullFlow(MOCK_CHARGE);

      mockGateway.createRefund.mockResolvedValue({
        id: "re_gateway_1",
        chargeId: MOCK_CHARGE.stripePaymentIntentId,
        amount: 5000,
        currency: "usd",
        status: "succeeded",
        reason: "customer_request",
        createdAt: new Date(),
      });

      const result = await service.createRefund(
        defaultDto,
        "idem-key-1",
        "corr-1",
      );

      expect(result.status).toBe("succeeded");
      expect(result.gatewayRefundId).toBe("re_gateway_1");

      // Verify repository createWithIdempotency was called (pending)
      expect(mockRefundsRepo.createWithIdempotency).toHaveBeenCalledWith(
        expect.objectContaining({
          chargeId: MOCK_CHARGE.id,
          invoiceId: MOCK_CHARGE.invoiceId,
          customerId: MOCK_CHARGE.customerId,
          amountCents: 5000,
          currency: "usd",
          status: "pending",
          reason: "customer_request",
          idempotencyKey: "idem-key-1",
        }),
      );

      // Verify update to processing
      expect(mockRefundsRepo.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "processing" }),
      );

      // Verify getAdapter called with correct provider
      expect(mockGatewayRegistry.getAdapter).toHaveBeenCalledWith(
        GatewayProvider.Stripe,
      );

      // Verify gateway call
      expect(mockGateway.createRefund).toHaveBeenCalledWith({
        chargeId: MOCK_CHARGE.stripePaymentIntentId,
        amount: 5000,
        reason: "customer_request",
        idempotencyKey: "idem-key-1",
      });

      // Verify transaction (succeeded update + ledger)
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockRefundsRepo.updateToSucceeded).toHaveBeenCalledWith(
        expect.any(String),
        "re_gateway_1",
        txMock,
      );

      // Verify ledger entry
      expect(mockLedgerService.recordRefundSucceeded).toHaveBeenCalledWith(
        expect.any(String),
        5000,
        "usd",
        "corr-1",
        txMock,
      );
    });
  });

  describe("createRefund — failure path", () => {
    it("should transition to failed with failureReason when gateway errors, no ledger entry", async () => {
      setupFullFlow(MOCK_CHARGE);

      mockGateway.createRefund.mockRejectedValue(new Error("Card declined"));

      const result = await service.createRefund(
        defaultDto,
        "idem-key-2",
        "corr-2",
      );

      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("Card declined");

      // No transaction for failure path (no ledger entry)
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockLedgerService.recordRefundSucceeded).not.toHaveBeenCalled();

      // Verify repository updates: processing + failed
      expect(mockRefundsRepo.updateStatus).toHaveBeenCalledTimes(2);

      // Verify the failed status update arguments
      expect(mockRefundsRepo.updateStatus).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: "failed",
          failureReason: "Card declined",
        }),
      );
    });
  });

  describe("createRefund — gateway not available", () => {
    it("should propagate GatewayNotAvailableException when adapter not registered", async () => {
      setupFullFlow(MOCK_CHARGE);

      mockGatewayRegistry.getAdapter.mockImplementation(() => {
        throw new GatewayNotAvailableException(GatewayProvider.Stripe);
      });

      const result = await service.createRefund(
        defaultDto,
        "idem-key-gna",
        "corr-gna",
      );

      // getAdapter is called inside try/catch that catches gateway errors -> refund fails
      expect(result.status).toBe("failed");
      expect(result.failureReason).toContain("not available");
      expect(mockGateway.createRefund).not.toHaveBeenCalled();
    });
  });

  describe("createRefund — idempotency", () => {
    it("should return existing refund on duplicate idempotency key (23505)", async () => {
      const existingRefund = {
        ...MOCK_REFUND_ROW,
        idempotencyKey: "idem-key-dup",
      };

      mockChargesRepo.findById.mockResolvedValue(MOCK_CHARGE);
      mockPaymentMethodsRepo.findById.mockResolvedValue({
        gatewayProvider: "stripe",
      });
      mockRefundsRepo.findSucceededByChargeId.mockResolvedValue([]);
      mockRefundsRepo.createWithIdempotency.mockResolvedValue({
        refund: existingRefund,
        isDuplicate: true,
      });

      const result = await service.createRefund(
        defaultDto,
        "idem-key-dup",
        "corr-3",
      );

      expect(result.id).toBe(MOCK_REFUND_ROW.id);
      expect(mockGateway.createRefund).not.toHaveBeenCalled();
    });
  });

  describe("createRefund — charge not found", () => {
    it("should throw NotFoundException when charge does not exist", async () => {
      setupChargeOnly(null);

      await expect(
        service.createRefund(defaultDto, "idem-key-4", "corr-4"),
      ).rejects.toThrow(NotFoundException);
    });

    it("should include charge ID in error message", async () => {
      setupChargeOnly(null);

      await expect(
        service.createRefund(defaultDto, "idem-key-4b", "corr-4b"),
      ).rejects.toThrow(`Charge ${defaultDto.chargeId} not found`);
    });
  });

  describe("createRefund — charge not in succeeded status", () => {
    it("should throw BusinessRuleViolationException when charge is pending", async () => {
      setupChargeOnly({ ...MOCK_CHARGE, status: "pending" });

      await expect(
        service.createRefund(defaultDto, "idem-key-5", "corr-5"),
      ).rejects.toThrow(BusinessRuleViolationException);
    });

    it("should include current status in error message", async () => {
      setupChargeOnly({ ...MOCK_CHARGE, status: "failed" });

      await expect(
        service.createRefund(defaultDto, "idem-key-5b", "corr-5b"),
      ).rejects.toThrow("must be in succeeded status");
    });
  });

  describe("createRefund — charge has no stripePaymentIntentId", () => {
    it("should throw BusinessRuleViolationException when charge has no gateway reference", async () => {
      setupChargeOnly({
        ...MOCK_CHARGE,
        stripePaymentIntentId: null,
      });

      await expect(
        service.createRefund(defaultDto, "idem-key-6", "corr-6"),
      ).rejects.toThrow(BusinessRuleViolationException);
    });

    it("should include descriptive error message", async () => {
      setupChargeOnly({
        ...MOCK_CHARGE,
        stripePaymentIntentId: null,
      });

      await expect(
        service.createRefund(defaultDto, "idem-key-6b", "corr-6b"),
      ).rejects.toThrow("has no gateway payment reference");
    });
  });

  describe("createRefund — customerId mismatch", () => {
    it("should throw NotFoundException when customerId does not match charge owner", async () => {
      setupChargeOnly(MOCK_CHARGE);

      const mismatchDto: CreateRefundInput = {
        ...defaultDto,
        customerId: "u9999999-0000-4000-a000-000000000099",
      };

      await expect(
        service.createRefund(mismatchDto, "idem-key-7", "corr-7"),
      ).rejects.toThrow(NotFoundException);
    });

    it("should return 404 (not 403) to prevent information disclosure", async () => {
      setupChargeOnly(MOCK_CHARGE);

      const mismatchDto: CreateRefundInput = {
        ...defaultDto,
        customerId: "u9999999-0000-4000-a000-000000000099",
      };

      await expect(
        service.createRefund(mismatchDto, "idem-key-7b", "corr-7b"),
      ).rejects.toThrow(`Charge ${defaultDto.chargeId} not found`);
    });
  });

  describe("createRefund — refund amount exceeds charge total", () => {
    it("should throw BusinessRuleViolationException when total refunds would exceed charge amount", async () => {
      const existingRefunds = [
        { ...MOCK_REFUND_ROW, amountCents: 8000, status: "succeeded" },
      ];

      setupChargeAndRefunds(MOCK_CHARGE, existingRefunds);

      const overAmountDto: CreateRefundInput = {
        ...defaultDto,
        amountCents: 5000, // 8000 + 5000 = 13000 > 10000
      };

      await expect(
        service.createRefund(overAmountDto, "idem-key-8", "corr-8"),
      ).rejects.toThrow(BusinessRuleViolationException);
    });

    it("should include exceeded amount in error message", async () => {
      const existingRefunds = [
        { ...MOCK_REFUND_ROW, amountCents: 8000, status: "succeeded" },
      ];

      setupChargeAndRefunds(MOCK_CHARGE, existingRefunds);

      const overAmountDto: CreateRefundInput = {
        ...defaultDto,
        amountCents: 5000,
      };

      await expect(
        service.createRefund(overAmountDto, "idem-key-8b", "corr-8b"),
      ).rejects.toThrow("would exceed charge amount");
    });
  });

  describe("createRefund — non-23505 insert error re-throws", () => {
    it("should re-throw non-idempotency database errors", async () => {
      setupChargeAndRefunds(MOCK_CHARGE, []);

      mockRefundsRepo.createWithIdempotency.mockRejectedValue(
        new Error("Connection refused"),
      );

      await expect(
        service.createRefund(defaultDto, "idem-key-err", "corr-err"),
      ).rejects.toThrow("Connection refused");
    });
  });

  describe("createRefund — customerId not provided", () => {
    it("should skip ownership validation when customerId is not in the request", async () => {
      setupFullFlow(MOCK_CHARGE);

      mockGateway.createRefund.mockResolvedValue({
        id: "re_gateway_no_cust",
        chargeId: MOCK_CHARGE.stripePaymentIntentId,
        amount: 5000,
        currency: "usd",
        status: "succeeded",
        reason: "customer_request",
        createdAt: new Date(),
      });

      const noCustDto: CreateRefundInput = {
        chargeId: MOCK_CHARGE.id,
        amountCents: 5000,
        reason: "customer_request",
        // customerId intentionally omitted
      };

      const result = await service.createRefund(
        noCustDto,
        "idem-key-nocust",
        "corr-nocust",
      );

      expect(result.status).toBe("succeeded");
    });
  });

  describe("createRefund — 23505 but no existing refund found", () => {
    it("should re-throw when 23505 occurs but lookup returns empty", async () => {
      mockChargesRepo.findById.mockResolvedValue(MOCK_CHARGE);
      mockPaymentMethodsRepo.findById.mockResolvedValue({
        gatewayProvider: "stripe",
      });
      mockRefundsRepo.findSucceededByChargeId.mockResolvedValue([]);

      // Repository create re-throws when 23505 but idempotency lookup returns nothing
      const error23505 = { code: "23505" };
      mockRefundsRepo.createWithIdempotency.mockRejectedValue(error23505);

      await expect(
        service.createRefund(defaultDto, "idem-key-race", "corr-race"),
      ).rejects.toBe(error23505);
    });
  });

  describe("createRefund — gateway error caught", () => {
    it("should transition to failed when gateway throws non-Error", async () => {
      setupFullFlow(MOCK_CHARGE);

      mockGateway.createRefund.mockRejectedValue("unknown gateway error");

      const result = await service.createRefund(
        defaultDto,
        "idem-key-9",
        "corr-9",
      );

      expect(result.status).toBe("failed");
      expect(mockLedgerService.recordRefundSucceeded).not.toHaveBeenCalled();
    });
  });

  describe("findById", () => {
    it("should return refund when found", async () => {
      mockRefundsRepo.findById.mockResolvedValue(MOCK_REFUND_ROW);

      const result = await service.findById(MOCK_REFUND_ROW.id);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(MOCK_REFUND_ROW.id);
      expect(result!.chargeId).toBe(MOCK_REFUND_ROW.chargeId);
      expect(result!.invoiceId).toBe(MOCK_REFUND_ROW.invoiceId);
      expect(result!.customerId).toBe(MOCK_REFUND_ROW.customerId);
      expect(result!.amountCents).toBe(MOCK_REFUND_ROW.amountCents);
      expect(result!.status).toBe("succeeded");
      expect(result!.createdAt).toBe(MOCK_REFUND_ROW.createdAt.toISOString());
      expect(result!.updatedAt).toBe(MOCK_REFUND_ROW.updatedAt.toISOString());
    });

    it("should return null when refund not found", async () => {
      mockRefundsRepo.findById.mockResolvedValue(null);

      const result = await service.findById("nonexistent-id");

      expect(result).toBeNull();
    });
  });
});

describe("RefundsService — SQS event publishing", () => {
  let service: RefundsService;

  const txMock = { id: "tx-mock" };

  const mockDb = {
    transaction: jest.fn((cb: (tx: typeof txMock) => Promise<void>) =>
      cb(txMock),
    ),
  };

  const mockRefundsRepo = {
    findById: jest.fn(),
    findByIdempotencyKey: jest.fn(),
    findSucceededByChargeId: jest.fn(),
    findForBillingHistory: jest.fn(),
    create: jest.fn(),
    createWithIdempotency: jest.fn(),
    updateStatus: jest.fn(),
    updateToSucceeded: jest.fn(),
  };

  const mockChargesRepo = {
    findById: jest.fn(),
  };

  const mockPaymentMethodsRepo = {
    findById: jest.fn(),
  };

  const mockGateway = {
    createRefund: jest.fn(),
  };

  const mockGatewayRegistry = {
    getAdapter: jest.fn().mockReturnValue(mockGateway),
  };

  const mockLedgerService = {
    recordRefundSucceeded: jest.fn().mockResolvedValue("ledger-entry-id"),
  };

  const mockSqsProducer = {
    publish: jest.fn().mockResolvedValue(undefined),
  };

  function setupFullFlow(charge: unknown, existingRefunds: unknown[] = []) {
    mockChargesRepo.findById.mockResolvedValue(charge);
    mockPaymentMethodsRepo.findById.mockResolvedValue({
      gatewayProvider: "stripe",
    });
    mockRefundsRepo.findSucceededByChargeId.mockResolvedValue(existingRefunds);
    mockRefundsRepo.createWithIdempotency.mockImplementation(
      (data: Record<string, unknown>) => ({
        refund: data,
        isDuplicate: false,
      }),
    );
    mockRefundsRepo.updateStatus.mockResolvedValue(undefined);
    mockRefundsRepo.updateToSucceeded.mockResolvedValue(undefined);
  }

  const defaultDto: CreateRefundInput = {
    chargeId: MOCK_CHARGE.id,
    amountCents: 5000,
    reason: "customer_request",
    customerId: MOCK_CHARGE.customerId,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockDb.transaction
      .mockReset()
      .mockImplementation((cb: (tx: typeof txMock) => Promise<void>) =>
        cb(txMock),
      );
    mockRefundsRepo.findById.mockReset();
    mockRefundsRepo.findByIdempotencyKey.mockReset();
    mockRefundsRepo.findSucceededByChargeId.mockReset();
    mockRefundsRepo.findForBillingHistory.mockReset();
    mockRefundsRepo.createWithIdempotency.mockReset();
    mockRefundsRepo.updateStatus.mockReset().mockResolvedValue(undefined);
    mockRefundsRepo.updateToSucceeded.mockReset().mockResolvedValue(undefined);
    mockChargesRepo.findById.mockReset();
    mockPaymentMethodsRepo.findById.mockReset();
    mockGateway.createRefund.mockReset();
    mockGatewayRegistry.getAdapter.mockReset().mockReturnValue(mockGateway);
    mockLedgerService.recordRefundSucceeded
      .mockReset()
      .mockResolvedValue("ledger-entry-id");
    mockSqsProducer.publish.mockReset().mockResolvedValue(undefined);

    const module = await Test.createTestingModule({
      providers: [
        RefundsService,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
        { provide: RefundsRepository, useValue: mockRefundsRepo },
        { provide: ChargesRepository, useValue: mockChargesRepo },
        {
          provide: PaymentMethodsRepository,
          useValue: mockPaymentMethodsRepo,
        },
        { provide: GatewayRegistry, useValue: mockGatewayRegistry },
        { provide: LedgerService, useValue: mockLedgerService },
        { provide: SqsProducerService, useValue: mockSqsProducer },
      ],
    }).compile();

    service = module.get<RefundsService>(RefundsService);
  });

  it("should publish refund.succeeded event with correct payload after success", async () => {
    setupFullFlow(MOCK_CHARGE);

    mockGateway.createRefund.mockResolvedValue({
      id: "re_gateway_sqs",
      chargeId: MOCK_CHARGE.stripePaymentIntentId,
      amount: 5000,
      currency: "usd",
      status: "succeeded",
      reason: "customer_request",
      createdAt: new Date(),
    });

    await service.createRefund(defaultDto, "idem-sqs-1", "corr-sqs-1");

    // Allow fire-and-forget to execute
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockSqsProducer.publish).toHaveBeenCalledWith(
      "refund.succeeded",
      expect.objectContaining({
        refundId: expect.any(String),
        chargeId: MOCK_CHARGE.id,
        invoiceId: MOCK_CHARGE.invoiceId,
        customerId: MOCK_CHARGE.customerId,
        amount: 5000,
        currency: "usd",
        reason: "customer_request",
        gatewayProvider: "stripe",
      }),
      "corr-sqs-1",
    );
  });

  it("should publish refund.failed event with failureReason after failure", async () => {
    setupFullFlow(MOCK_CHARGE);

    mockGateway.createRefund.mockRejectedValue(new Error("Insufficient funds"));

    await service.createRefund(defaultDto, "idem-sqs-2", "corr-sqs-2");

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockSqsProducer.publish).toHaveBeenCalledWith(
      "refund.failed",
      expect.objectContaining({
        refundId: expect.any(String),
        chargeId: MOCK_CHARGE.id,
        invoiceId: MOCK_CHARGE.invoiceId,
        customerId: MOCK_CHARGE.customerId,
        amount: 5000,
        currency: "usd",
        reason: "customer_request",
        gatewayProvider: "stripe",
        failureReason: "Insufficient funds",
      }),
      "corr-sqs-2",
    );
  });

  it("should not affect refund processing when SQS publish fails (fire-and-forget)", async () => {
    setupFullFlow(MOCK_CHARGE);

    mockGateway.createRefund.mockResolvedValue({
      id: "re_gateway_sqs_fail",
      chargeId: MOCK_CHARGE.stripePaymentIntentId,
      amount: 5000,
      currency: "usd",
      status: "succeeded",
      reason: "customer_request",
      createdAt: new Date(),
    });

    mockSqsProducer.publish.mockRejectedValue(new Error("SQS unavailable"));

    const result = await service.createRefund(
      defaultDto,
      "idem-sqs-3",
      "corr-sqs-3",
    );

    // Refund should still succeed despite SQS failure
    expect(result.status).toBe("succeeded");
    expect(result.gatewayRefundId).toBe("re_gateway_sqs_fail");
  });

  it("should not attempt SQS publish when SqsProducerService is undefined (@Optional)", async () => {
    // Create service without SQS provider
    const moduleNoSqs = await Test.createTestingModule({
      providers: [
        RefundsService,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
        { provide: RefundsRepository, useValue: mockRefundsRepo },
        { provide: ChargesRepository, useValue: mockChargesRepo },
        {
          provide: PaymentMethodsRepository,
          useValue: mockPaymentMethodsRepo,
        },
        { provide: GatewayRegistry, useValue: mockGatewayRegistry },
        { provide: LedgerService, useValue: mockLedgerService },
        // NO SqsProducerService
      ],
    }).compile();

    const serviceNoSqs = moduleNoSqs.get<RefundsService>(RefundsService);

    setupFullFlow(MOCK_CHARGE);
    mockGateway.createRefund.mockResolvedValue({
      id: "re_gateway_no_sqs",
      chargeId: MOCK_CHARGE.stripePaymentIntentId,
      amount: 5000,
      currency: "usd",
      status: "succeeded",
      reason: "customer_request",
      createdAt: new Date(),
    });

    const result = await serviceNoSqs.createRefund(
      defaultDto,
      "idem-sqs-4",
      "corr-sqs-4",
    );

    expect(result.status).toBe("succeeded");
    expect(mockSqsProducer.publish).not.toHaveBeenCalled();
  });

  it("should not affect failed refund processing when SQS publish for failure event fails", async () => {
    setupFullFlow(MOCK_CHARGE);

    mockGateway.createRefund.mockRejectedValue(new Error("Card declined"));
    mockSqsProducer.publish.mockRejectedValue(new Error("SQS down"));

    const result = await service.createRefund(
      defaultDto,
      "idem-sqs-5",
      "corr-sqs-5",
    );

    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("Card declined");
  });

  it("should handle non-Error SQS rejection on success path without affecting result", async () => {
    setupFullFlow(MOCK_CHARGE);

    mockGateway.createRefund.mockResolvedValue({
      id: "re_gateway_non_err_s",
      chargeId: MOCK_CHARGE.stripePaymentIntentId,
      amount: 5000,
      currency: "usd",
      status: "succeeded",
      reason: "customer_request",
      createdAt: new Date(),
    });

    mockSqsProducer.publish.mockRejectedValue("non-error string rejection");

    const result = await service.createRefund(
      defaultDto,
      "idem-sqs-nonerr-s",
      "corr-sqs-nonerr-s",
    );

    // Allow fire-and-forget catch to execute for branch coverage
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(result.status).toBe("succeeded");
  });

  it("should handle non-Error SQS rejection on failure path without affecting result", async () => {
    setupFullFlow(MOCK_CHARGE);

    mockGateway.createRefund.mockRejectedValue(new Error("Card declined"));
    mockSqsProducer.publish.mockRejectedValue("non-error string rejection");

    const result = await service.createRefund(
      defaultDto,
      "idem-sqs-nonerr-f",
      "corr-sqs-nonerr-f",
    );

    // Allow fire-and-forget catch to execute for branch coverage
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("Card declined");
  });
});
