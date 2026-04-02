import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SubscriptionsService } from "./subscriptions.service";
import { SubscriptionsRepository } from "./subscriptions.repository";
import { CustomersService } from "../customers/customers.service";
import { PaymentMethodsService } from "../payment-methods/payment-methods.service";
import { SqsProducerService } from "../integration/sqs/sqs-producer.service";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import { SubscriptionNotFoundException } from "../common/exceptions/subscription-not-found.exception";
import { NoPaymentMethodException } from "../common/exceptions/no-payment-method.exception";
import { StateTransitionException } from "../common/exceptions/billing.exception";
import type { CreateSubscriptionDto } from "./dto/create-subscription.dto";

const mockSubscriptionsRepo = {
  findById: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  deleteById: jest.fn(),
  updateStateWithConcurrencyCheck: jest.fn(),
  findByCustomerAndStatuses: jest.fn(),
  updateByCustomerAndStatuses: jest.fn(),
  findByCustomer: jest.fn(),
  findDueForBilling: jest.fn(),
  findAllWithFilters: jest.fn(),
  findAllWithCustomer: jest.fn().mockResolvedValue([]),
  getActiveMetrics: jest.fn(),
};

const mockCustomersService = {
  findById: jest.fn(),
};

const mockPaymentMethodsService = {
  findAll: jest.fn(),
};

const mockSqsProducerService = {
  publish: jest.fn().mockResolvedValue(undefined),
};

const mockCustomer = {
  id: "cust-123",
  monolithCustomerId: "mono-123",
  stripeCustomerId: "stripe-123",
  name: "Test Customer",
  email: "test@example.com",
  status: "active",
  metadata: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const mockPaymentMethod = {
  id: "pm-123",
  customerId: "cust-123",
  stripePaymentMethodId: "spm-123",
  type: "card",
  isDefault: true,
  lastFour: "4242",
  brand: "visa",
  bankName: null,
  expiryMonth: 12,
  expiryYear: 2030,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const now = new Date("2026-03-01T00:00:00.000Z");

const mockSubscriptionRow = {
  id: "sub-123",
  customerId: "cust-123",
  planName: "standard-monthly",
  status: "pending",
  amountCents: 5000,
  currency: "usd",
  billingInterval: "monthly",
  billingPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
  nextBillingDate: new Date("2026-04-01T00:00:00.000Z"),
  stripeSubscriptionId: null,
  metadata: null,
  createdAt: now,
  updatedAt: now,
};

const createDto: CreateSubscriptionDto = {
  customerId: "cust-123",
  planName: "standard-monthly",
  amountCents: 5000,
  billingStartDate: "2026-03-01T00:00:00.000Z",
};

describe("SubscriptionsService", () => {
  let service: SubscriptionsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSubscriptionsRepo.findAllWithCustomer.mockResolvedValue([]);

    const module = await Test.createTestingModule({
      providers: [
        SubscriptionsService,
        { provide: SubscriptionsRepository, useValue: mockSubscriptionsRepo },
        { provide: CustomersService, useValue: mockCustomersService },
        { provide: PaymentMethodsService, useValue: mockPaymentMethodsService },
        { provide: SqsProducerService, useValue: mockSqsProducerService },
      ],
    }).compile();

    service = module.get<SubscriptionsService>(SubscriptionsService);
  });

  describe("create", () => {
    it("should create a subscription successfully", async () => {
      mockCustomersService.findById.mockResolvedValue(mockCustomer);
      mockPaymentMethodsService.findAll.mockResolvedValue({
        data: [mockPaymentMethod],
        cursor: null,
        hasMore: false,
      });
      mockSubscriptionsRepo.create.mockResolvedValue(mockSubscriptionRow);

      const result = await service.create(createDto);

      expect(result.id).toBe("sub-123");
      expect(result.customerId).toBe("cust-123");
      expect(result.planName).toBe("standard-monthly");
      expect(result.status).toBe("pending");
      expect(result.amountCents).toBe(5000);
      expect(result.currency).toBe("usd");
      expect(result.billingInterval).toBe("monthly");
      expect(mockCustomersService.findById).toHaveBeenCalledWith("cust-123");
      expect(mockPaymentMethodsService.findAll).toHaveBeenCalledWith(
        "cust-123",
        { limit: 1 },
      );
    });

    it("should throw CustomerNotFoundException when customer does not exist", async () => {
      mockCustomersService.findById.mockResolvedValue(null);

      await expect(service.create(createDto)).rejects.toThrow(
        CustomerNotFoundException,
      );
    });

    it("should throw NoPaymentMethodException when customer has no payment methods", async () => {
      mockCustomersService.findById.mockResolvedValue(mockCustomer);
      mockPaymentMethodsService.findAll.mockResolvedValue({
        data: [],
        cursor: null,
        hasMore: false,
      });

      await expect(service.create(createDto)).rejects.toThrow(
        NoPaymentMethodException,
      );
    });

    it("should calculate billing period end correctly for monthly interval", async () => {
      mockCustomersService.findById.mockResolvedValue(mockCustomer);
      mockPaymentMethodsService.findAll.mockResolvedValue({
        data: [mockPaymentMethod],
        cursor: null,
        hasMore: false,
      });
      mockSubscriptionsRepo.create.mockResolvedValue(mockSubscriptionRow);

      await service.create(createDto);

      const createCall = mockSubscriptionsRepo.create.mock
        .calls[0][0] as Record<string, unknown>;
      const periodEnd = createCall.billingPeriodEnd as Date;
      expect(periodEnd.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    });

    it("should handle end-of-month billing period calculation", async () => {
      mockCustomersService.findById.mockResolvedValue(mockCustomer);
      mockPaymentMethodsService.findAll.mockResolvedValue({
        data: [mockPaymentMethod],
        cursor: null,
        hasMore: false,
      });

      const jan31Subscription = {
        ...mockSubscriptionRow,
        billingPeriodStart: new Date("2026-01-31T00:00:00.000Z"),
        billingPeriodEnd: new Date("2026-02-28T00:00:00.000Z"),
        nextBillingDate: new Date("2026-02-28T00:00:00.000Z"),
      };
      mockSubscriptionsRepo.create.mockResolvedValue(jan31Subscription);

      const dto = {
        ...createDto,
        billingStartDate: "2026-01-31T00:00:00.000Z",
      };
      await service.create(dto);

      const createCall = mockSubscriptionsRepo.create.mock
        .calls[0][0] as Record<string, unknown>;
      const periodEnd = createCall.billingPeriodEnd as Date;
      expect(periodEnd.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    });

    it("should use default currency and billing interval when not provided", async () => {
      mockCustomersService.findById.mockResolvedValue(mockCustomer);
      mockPaymentMethodsService.findAll.mockResolvedValue({
        data: [mockPaymentMethod],
        cursor: null,
        hasMore: false,
      });
      mockSubscriptionsRepo.create.mockResolvedValue(mockSubscriptionRow);

      await service.create(createDto);

      const createCall = mockSubscriptionsRepo.create.mock
        .calls[0][0] as Record<string, unknown>;
      expect(createCall.currency).toBe("usd");
      expect(createCall.billingInterval).toBe("monthly");
    });

    it("should set next_billing_date equal to billing_period_end", async () => {
      mockCustomersService.findById.mockResolvedValue(mockCustomer);
      mockPaymentMethodsService.findAll.mockResolvedValue({
        data: [mockPaymentMethod],
        cursor: null,
        hasMore: false,
      });
      mockSubscriptionsRepo.create.mockResolvedValue(mockSubscriptionRow);

      await service.create(createDto);

      const createCall = mockSubscriptionsRepo.create.mock
        .calls[0][0] as Record<string, unknown>;
      expect(createCall.nextBillingDate).toEqual(createCall.billingPeriodEnd);
    });
  });

  describe("findById", () => {
    it("should return subscription when found", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(mockSubscriptionRow);

      const result = await service.findById("sub-123");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("sub-123");
      expect(result?.billingPeriodStart).toBe("2026-03-01T00:00:00.000Z");
    });

    it("should return null when subscription not found", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(null);

      const result = await service.findById("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("findAll", () => {
    const mockJoinedRow = {
      subscription: mockSubscriptionRow,
      customerName: "Test Customer",
      customerEmail: "test@example.com",
    };

    it("should return subscriptions with customer name and email", async () => {
      mockSubscriptionsRepo.findAllWithCustomer.mockResolvedValue([
        mockJoinedRow,
      ]);

      const result = await service.findAll({});

      expect(result.data).toHaveLength(1);
      expect(result.data[0].customerName).toBe("Test Customer");
      expect(result.data[0].customerEmail).toBe("test@example.com");
      expect(result.data[0].id).toBe("sub-123");
      expect(mockSubscriptionsRepo.findAllWithCustomer).toHaveBeenCalledWith(
        {
          customerId: undefined,
          status: undefined,
          startDate: undefined,
          endDate: undefined,
          cursor: undefined,
        },
        20,
      );
    });

    it("should return paginated results", async () => {
      mockSubscriptionsRepo.findAllWithCustomer.mockResolvedValue([
        mockJoinedRow,
        {
          subscription: { ...mockSubscriptionRow, id: "sub-456" },
          customerName: "Test Customer",
          customerEmail: "test@example.com",
        },
      ]);

      const result = await service.findAll({ limit: 1 });

      expect(result.data).toHaveLength(1);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe("sub-123");
    });

    it("should filter by customerId", async () => {
      mockSubscriptionsRepo.findAllWithCustomer.mockResolvedValue([
        mockJoinedRow,
      ]);

      await service.findAll({ customerId: "cust-123" });

      expect(mockSubscriptionsRepo.findAllWithCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: "cust-123" }),
        20,
      );
    });

    it("should filter by status", async () => {
      mockSubscriptionsRepo.findAllWithCustomer.mockResolvedValue([]);

      await service.findAll({ status: "active" });

      expect(mockSubscriptionsRepo.findAllWithCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ status: "active" }),
        20,
      );
    });

    it("should filter by startDate only", async () => {
      mockSubscriptionsRepo.findAllWithCustomer.mockResolvedValue([
        mockJoinedRow,
      ]);

      await service.findAll({ startDate: "2026-01-01T00:00:00.000Z" });

      expect(mockSubscriptionsRepo.findAllWithCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: "2026-01-01T00:00:00.000Z" }),
        20,
      );
    });

    it("should filter by endDate only", async () => {
      mockSubscriptionsRepo.findAllWithCustomer.mockResolvedValue([
        mockJoinedRow,
      ]);

      await service.findAll({ endDate: "2026-12-31T23:59:59.999Z" });

      expect(mockSubscriptionsRepo.findAllWithCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ endDate: "2026-12-31T23:59:59.999Z" }),
        20,
      );
    });

    it("should filter by startDate AND endDate", async () => {
      mockSubscriptionsRepo.findAllWithCustomer.mockResolvedValue([
        mockJoinedRow,
      ]);

      await service.findAll({
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-12-31T23:59:59.999Z",
      });

      expect(mockSubscriptionsRepo.findAllWithCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: "2026-01-01T00:00:00.000Z",
          endDate: "2026-12-31T23:59:59.999Z",
        }),
        20,
      );
    });

    it("should combine customerId, status, and date range filters", async () => {
      mockSubscriptionsRepo.findAllWithCustomer.mockResolvedValue([
        mockJoinedRow,
      ]);

      await service.findAll({
        customerId: "cust-123",
        status: "active",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-06-30T23:59:59.999Z",
      });

      expect(mockSubscriptionsRepo.findAllWithCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cust-123",
          status: "active",
          startDate: "2026-01-01T00:00:00.000Z",
          endDate: "2026-06-30T23:59:59.999Z",
        }),
        20,
      );
    });

    it("should return empty results when no matches", async () => {
      mockSubscriptionsRepo.findAllWithCustomer.mockResolvedValue([]);

      const result = await service.findAll({});

      expect(result.data).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it("should handle cursor-based pagination with joined data", async () => {
      mockSubscriptionsRepo.findAllWithCustomer.mockResolvedValue([
        mockJoinedRow,
      ]);

      const result = await service.findAll({
        cursor: "prev-cursor",
        limit: 20,
      });

      expect(mockSubscriptionsRepo.findAllWithCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: "prev-cursor" }),
        20,
      );
      expect(result.data).toHaveLength(1);
    });

    it("should handle null customer fields from LEFT JOIN", async () => {
      const rowWithNullCustomer = {
        subscription: mockSubscriptionRow,
        customerName: null,
        customerEmail: null,
      };
      mockSubscriptionsRepo.findAllWithCustomer.mockResolvedValue([
        rowWithNullCustomer,
      ]);

      const result = await service.findAll({});

      expect(result.data[0].customerName).toBeNull();
      expect(result.data[0].customerEmail).toBeNull();
    });
  });

  describe("updateState", () => {
    const pendingRow = { ...mockSubscriptionRow, status: "pending" };
    const activeRow = { ...mockSubscriptionRow, status: "active" };
    const pausedRow = {
      ...mockSubscriptionRow,
      status: "paused",
      nextBillingDate: null,
    };
    const canceledRow = { ...mockSubscriptionRow, status: "canceled" };

    it("should transition pending to active", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(pendingRow);
      const updatedRow = { ...pendingRow, status: "active" };
      mockSubscriptionsRepo.updateStateWithConcurrencyCheck.mockResolvedValue(
        updatedRow,
      );

      const result = await service.updateState("sub-123", {
        status: "active",
      });

      expect(result.status).toBe("active");
      expect(
        mockSubscriptionsRepo.updateStateWithConcurrencyCheck,
      ).toHaveBeenCalled();
    });

    it("should throw SubscriptionNotFoundException when subscription not found", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(null);

      await expect(
        service.updateState("non-existent", { status: "active" }),
      ).rejects.toThrow(SubscriptionNotFoundException);
    });

    it("should throw StateTransitionException for invalid transition", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(canceledRow);

      await expect(
        service.updateState("sub-123", { status: "active" }),
      ).rejects.toThrow(StateTransitionException);
    });

    it("should set next_billing_date to null when transitioning to paused", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(activeRow);
      const updatedRow = {
        ...activeRow,
        status: "paused",
        nextBillingDate: null,
      };
      mockSubscriptionsRepo.updateStateWithConcurrencyCheck.mockResolvedValue(
        updatedRow,
      );

      await service.updateState("sub-123", { status: "paused" });

      const updateCall = mockSubscriptionsRepo.updateStateWithConcurrencyCheck
        .mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.nextBillingDate).toBeNull();
      expect(updateCall.status).toBe("paused");
    });

    it("should recalculate billing dates when resuming from paused to active", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(pausedRow);
      const updatedRow = {
        ...pausedRow,
        status: "active",
        billingPeriodStart: new Date(),
        billingPeriodEnd: new Date(),
        nextBillingDate: new Date(),
      };
      mockSubscriptionsRepo.updateStateWithConcurrencyCheck.mockResolvedValue(
        updatedRow,
      );

      await service.updateState("sub-123", { status: "active" });

      const updateCall = mockSubscriptionsRepo.updateStateWithConcurrencyCheck
        .mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.billingPeriodStart).toBeInstanceOf(Date);
      expect(updateCall.billingPeriodEnd).toBeInstanceOf(Date);
      expect(updateCall.nextBillingDate).toBeInstanceOf(Date);
      expect(updateCall.status).toBe("active");
    });

    it("should not modify billing dates for cancel transition", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(activeRow);
      const updatedRow = { ...activeRow, status: "canceled" };
      mockSubscriptionsRepo.updateStateWithConcurrencyCheck.mockResolvedValue(
        updatedRow,
      );

      await service.updateState("sub-123", { status: "canceled" });

      const updateCall = mockSubscriptionsRepo.updateStateWithConcurrencyCheck
        .mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.status).toBe("canceled");
      expect(updateCall.billingPeriodStart).toBeUndefined();
      expect(updateCall.billingPeriodEnd).toBeUndefined();
      expect(updateCall.nextBillingDate).toBeUndefined();
    });

    it("should publish subscription.state.changed event after DB update", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(pendingRow);
      const updatedRow = { ...pendingRow, status: "active" };
      mockSubscriptionsRepo.updateStateWithConcurrencyCheck.mockResolvedValue(
        updatedRow,
      );

      await service.updateState("sub-123", { status: "active" }, "corr-123");

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "subscription.state.changed",
        {
          subscriptionId: "sub-123",
          customerId: "cust-123",
          oldState: "pending",
          newState: "active",
          changedAt: expect.any(String),
        },
        "corr-123",
        undefined,
      );
    });

    it("should pass correlationId to SQS publish", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(pendingRow);
      const updatedRow = { ...pendingRow, status: "active" };
      mockSubscriptionsRepo.updateStateWithConcurrencyCheck.mockResolvedValue(
        updatedRow,
      );

      await service.updateState(
        "sub-123",
        { status: "active" },
        "my-correlation-id",
      );

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "subscription.state.changed",
        expect.any(Object),
        "my-correlation-id",
        undefined,
      );
    });

    it("should use empty string for correlationId when not provided", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(pendingRow);
      const updatedRow = { ...pendingRow, status: "active" };
      mockSubscriptionsRepo.updateStateWithConcurrencyCheck.mockResolvedValue(
        updatedRow,
      );

      await service.updateState("sub-123", { status: "active" });

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "subscription.state.changed",
        expect.any(Object),
        "",
        undefined,
      );
    });

    it("should call repo update with correct status and updatedAt", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(pendingRow);
      const updatedRow = { ...pendingRow, status: "active" };
      mockSubscriptionsRepo.updateStateWithConcurrencyCheck.mockResolvedValue(
        updatedRow,
      );

      await service.updateState("sub-123", { status: "active" });

      const updateCall = mockSubscriptionsRepo.updateStateWithConcurrencyCheck
        .mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.status).toBe("active");
      expect(updateCall.updatedAt).toBeInstanceOf(Date);
    });

    it("should handle toResponseDto with null nextBillingDate", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(activeRow);
      const updatedRow = {
        ...activeRow,
        status: "paused",
        nextBillingDate: null,
      };
      mockSubscriptionsRepo.updateStateWithConcurrencyCheck.mockResolvedValue(
        updatedRow,
      );

      const result = await service.updateState("sub-123", {
        status: "paused",
      });

      expect(result.nextBillingDate).toBeNull();
    });

    it("should throw StateTransitionException when state is modified concurrently", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(pendingRow);
      mockSubscriptionsRepo.updateStateWithConcurrencyCheck.mockResolvedValue(
        null,
      );

      await expect(
        service.updateState("sub-123", { status: "active" }),
      ).rejects.toThrow(StateTransitionException);
    });
  });

  describe("advanceBillingPeriod", () => {
    it("should advance billing period successfully", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(mockSubscriptionRow);

      const advancedRow = {
        ...mockSubscriptionRow,
        billingPeriodStart: new Date("2026-04-01T00:00:00.000Z"),
        billingPeriodEnd: new Date("2026-05-01T00:00:00.000Z"),
        nextBillingDate: new Date("2026-05-01T00:00:00.000Z"),
      };
      mockSubscriptionsRepo.update.mockResolvedValue(advancedRow);

      const result = await service.advanceBillingPeriod("sub-123");

      expect(result.billingPeriodStart).toBe("2026-04-01T00:00:00.000Z");
      expect(result.billingPeriodEnd).toBe("2026-05-01T00:00:00.000Z");
      expect(result.nextBillingDate).toBe("2026-05-01T00:00:00.000Z");
    });

    it("should throw SubscriptionNotFoundException when subscription not found", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(null);

      await expect(
        service.advanceBillingPeriod("non-existent"),
      ).rejects.toThrow(SubscriptionNotFoundException);
    });

    it("should set new start to old end", async () => {
      mockSubscriptionsRepo.findById.mockResolvedValue(mockSubscriptionRow);

      const advancedRow = {
        ...mockSubscriptionRow,
        billingPeriodStart: new Date("2026-04-01T00:00:00.000Z"),
        billingPeriodEnd: new Date("2026-05-01T00:00:00.000Z"),
        nextBillingDate: new Date("2026-05-01T00:00:00.000Z"),
      };
      mockSubscriptionsRepo.update.mockResolvedValue(advancedRow);

      await service.advanceBillingPeriod("sub-123");

      const updateCall = mockSubscriptionsRepo.update.mock
        .calls[0][1] as Record<string, unknown>;
      const newStart = updateCall.billingPeriodStart as Date;
      expect(newStart.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    });
  });

  describe("updatePricing", () => {
    const activeSubscription = {
      ...mockSubscriptionRow,
      id: "sub-active",
      status: "active",
      amountCents: 5000,
    };

    const pausedSubscription = {
      ...mockSubscriptionRow,
      id: "sub-paused",
      status: "paused",
      amountCents: 5000,
      nextBillingDate: null,
    };

    it("should update amount_cents for active subscription", async () => {
      mockSubscriptionsRepo.findByCustomerAndStatuses.mockResolvedValue([
        activeSubscription,
      ]);
      mockSubscriptionsRepo.updateByCustomerAndStatuses.mockResolvedValue(
        undefined,
      );

      const count = await service.updatePricing("cust-123", 7500);

      expect(count).toBe(1);
      expect(
        mockSubscriptionsRepo.updateByCustomerAndStatuses,
      ).toHaveBeenCalledWith(
        "cust-123",
        ["active", "paused"],
        expect.objectContaining({ amountCents: 7500 }),
      );
    });

    it("should update amount_cents for paused subscription", async () => {
      mockSubscriptionsRepo.findByCustomerAndStatuses.mockResolvedValue([
        pausedSubscription,
      ]);
      mockSubscriptionsRepo.updateByCustomerAndStatuses.mockResolvedValue(
        undefined,
      );

      const count = await service.updatePricing("cust-123", 8000);

      expect(count).toBe(1);
      expect(
        mockSubscriptionsRepo.updateByCustomerAndStatuses,
      ).toHaveBeenCalled();
    });

    it("should update multiple qualifying subscriptions (active + paused)", async () => {
      mockSubscriptionsRepo.findByCustomerAndStatuses.mockResolvedValue([
        activeSubscription,
        pausedSubscription,
      ]);
      mockSubscriptionsRepo.updateByCustomerAndStatuses.mockResolvedValue(
        undefined,
      );

      const count = await service.updatePricing("cust-123", 9000);

      expect(count).toBe(2);
      expect(
        mockSubscriptionsRepo.updateByCustomerAndStatuses,
      ).toHaveBeenCalled();
    });

    it("should return 0 when no matching subscriptions exist", async () => {
      mockSubscriptionsRepo.findByCustomerAndStatuses.mockResolvedValue([]);

      const count = await service.updatePricing("cust-123", 7500);

      expect(count).toBe(0);
      expect(
        mockSubscriptionsRepo.updateByCustomerAndStatuses,
      ).not.toHaveBeenCalled();
    });

    it("should skip canceled subscriptions (not returned by query)", async () => {
      mockSubscriptionsRepo.findByCustomerAndStatuses.mockResolvedValue([]);

      const count = await service.updatePricing("cust-123", 7500);

      expect(count).toBe(0);
    });

    it("should skip past_due subscriptions (not returned by query)", async () => {
      mockSubscriptionsRepo.findByCustomerAndStatuses.mockResolvedValue([]);

      const count = await service.updatePricing("cust-123", 7500);

      expect(count).toBe(0);
    });

    it("should skip pending subscriptions (not returned by query)", async () => {
      mockSubscriptionsRepo.findByCustomerAndStatuses.mockResolvedValue([]);

      const count = await service.updatePricing("cust-123", 7500);

      expect(count).toBe(0);
    });

    it("should log old and new amounts with structured format", async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, "log")
        .mockImplementation(() => {});
      mockSubscriptionsRepo.findByCustomerAndStatuses.mockResolvedValue([
        activeSubscription,
      ]);
      mockSubscriptionsRepo.updateByCustomerAndStatuses.mockResolvedValue(
        undefined,
      );

      await service.updatePricing("cust-123", 7500, "corr-123");

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Subscription pricing updated",
          subscriptionId: "sub-active",
          customerId: "cust-123",
          oldAmount: 5000,
          newAmount: 7500,
          action: "pricing.updated",
          correlationId: "corr-123",
        }),
      );
      logSpy.mockRestore();
    });

    it("should return 0 and warn for negative amountCents", async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      const count = await service.updatePricing("cust-123", -100);

      expect(count).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Invalid amountCents for pricing update — skipping",
          amountCents: -100,
        }),
      );
      expect(
        mockSubscriptionsRepo.updateByCustomerAndStatuses,
      ).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("should return 0 and warn for zero amountCents", async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      const count = await service.updatePricing("cust-123", 0);

      expect(count).toBe(0);
      expect(
        mockSubscriptionsRepo.updateByCustomerAndStatuses,
      ).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("should return 0 and warn for non-integer amountCents", async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      const count = await service.updatePricing("cust-123", 50.5);

      expect(count).toBe(0);
      expect(
        mockSubscriptionsRepo.updateByCustomerAndStatuses,
      ).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("should NOT modify billing period fields", async () => {
      mockSubscriptionsRepo.findByCustomerAndStatuses.mockResolvedValue([
        activeSubscription,
      ]);
      mockSubscriptionsRepo.updateByCustomerAndStatuses.mockResolvedValue(
        undefined,
      );

      await service.updatePricing("cust-123", 7500);

      const updateCall = mockSubscriptionsRepo.updateByCustomerAndStatuses.mock
        .calls[0][2] as Record<string, unknown>;
      expect(updateCall.amountCents).toBe(7500);
      expect(updateCall.updatedAt).toBeInstanceOf(Date);
      // billing period fields must not be in the set call
      expect(updateCall.billingPeriodStart).toBeUndefined();
      expect(updateCall.billingPeriodEnd).toBeUndefined();
      expect(updateCall.nextBillingDate).toBeUndefined();
    });
  });
});
