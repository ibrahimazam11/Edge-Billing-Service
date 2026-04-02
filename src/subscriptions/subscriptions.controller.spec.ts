import { Test } from "@nestjs/testing";
import { SubscriptionsController } from "./subscriptions.controller";
import { SubscriptionsService } from "./subscriptions.service";
import { SubscriptionNotFoundException } from "../common/exceptions/subscription-not-found.exception";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import { NoPaymentMethodException } from "../common/exceptions/no-payment-method.exception";
import { StateTransitionException } from "../common/exceptions/billing.exception";
import type { SubscriptionResponseDto } from "./dto/subscription-response.dto";

const mockSubscription: SubscriptionResponseDto = {
  id: "sub-123",
  customerId: "cust-123",
  planName: "standard-monthly",
  status: "pending",
  amountCents: 5000,
  currency: "usd",
  billingInterval: "monthly",
  billingPeriodStart: "2026-03-01T00:00:00.000Z",
  billingPeriodEnd: "2026-04-01T00:00:00.000Z",
  nextBillingDate: "2026-04-01T00:00:00.000Z",
  stripeSubscriptionId: null,
  metadata: null,
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
};

const mockSubscriptionsService = {
  create: jest.fn(),
  findById: jest.fn(),
  findAll: jest.fn(),
  updateState: jest.fn(),
};

describe("SubscriptionsController", () => {
  let controller: SubscriptionsController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      controllers: [SubscriptionsController],
      providers: [
        { provide: SubscriptionsService, useValue: mockSubscriptionsService },
      ],
    }).compile();

    controller = module.get<SubscriptionsController>(SubscriptionsController);
  });

  describe("POST /v1/subscriptions", () => {
    it("should create a subscription and return 201", async () => {
      mockSubscriptionsService.create.mockResolvedValue(mockSubscription);

      const dto = {
        customerId: "cust-123",
        planName: "standard-monthly",
        amountCents: 5000,
        billingStartDate: "2026-03-01T00:00:00.000Z",
      };

      const result = await controller.create(dto, "corr-123");

      expect(result).toEqual(mockSubscription);
      expect(mockSubscriptionsService.create).toHaveBeenCalledWith(
        dto,
        "corr-123",
      );
    });

    it("should propagate CustomerNotFoundException (404)", async () => {
      mockSubscriptionsService.create.mockRejectedValue(
        new CustomerNotFoundException("cust-999"),
      );

      const dto = {
        customerId: "cust-999",
        planName: "standard-monthly",
        amountCents: 5000,
        billingStartDate: "2026-03-01T00:00:00.000Z",
      };

      await expect(controller.create(dto)).rejects.toThrow(
        CustomerNotFoundException,
      );
    });

    it("should propagate NoPaymentMethodException (422)", async () => {
      mockSubscriptionsService.create.mockRejectedValue(
        new NoPaymentMethodException("cust-123"),
      );

      const dto = {
        customerId: "cust-123",
        planName: "standard-monthly",
        amountCents: 5000,
        billingStartDate: "2026-03-01T00:00:00.000Z",
      };

      await expect(controller.create(dto)).rejects.toThrow(
        NoPaymentMethodException,
      );
    });
  });

  describe("GET /v1/subscriptions/:id", () => {
    it("should return subscription when found", async () => {
      mockSubscriptionsService.findById.mockResolvedValue(mockSubscription);

      const result = await controller.findById("sub-123");

      expect(result).toEqual(mockSubscription);
    });

    it("should throw SubscriptionNotFoundException when not found", async () => {
      mockSubscriptionsService.findById.mockResolvedValue(null);

      await expect(controller.findById("non-existent")).rejects.toThrow(
        SubscriptionNotFoundException,
      );
    });
  });

  describe("PUT /v1/subscriptions/:id", () => {
    const updatedSubscription: SubscriptionResponseDto = {
      ...mockSubscription,
      status: "active",
    };

    it("should update subscription state and return 200", async () => {
      mockSubscriptionsService.updateState.mockResolvedValue(
        updatedSubscription,
      );

      const result = await controller.updateState(
        "sub-123",
        { status: "active" },
        "corr-123",
      );

      expect(result).toEqual(updatedSubscription);
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledWith(
        "sub-123",
        { status: "active" },
        "corr-123",
      );
    });

    it("should propagate SubscriptionNotFoundException (404)", async () => {
      mockSubscriptionsService.updateState.mockRejectedValue(
        new SubscriptionNotFoundException("non-existent"),
      );

      await expect(
        controller.updateState("non-existent", { status: "active" }),
      ).rejects.toThrow(SubscriptionNotFoundException);
    });

    it("should propagate StateTransitionException (409)", async () => {
      mockSubscriptionsService.updateState.mockRejectedValue(
        new StateTransitionException("Invalid transition", {
          currentState: "canceled",
          targetState: "active",
          allowedTransitions: [],
        }),
      );

      await expect(
        controller.updateState("sub-123", { status: "active" }),
      ).rejects.toThrow(StateTransitionException);
    });
  });

  describe("GET /v1/subscriptions", () => {
    it("should return paginated subscriptions", async () => {
      const paginatedResult = {
        data: [mockSubscription],
        cursor: null,
        hasMore: false,
      };
      mockSubscriptionsService.findAll.mockResolvedValue(paginatedResult);

      const result = await controller.findAll({});

      expect(result).toEqual(paginatedResult);
    });

    it("should pass query filters to service", async () => {
      mockSubscriptionsService.findAll.mockResolvedValue({
        data: [],
        cursor: null,
        hasMore: false,
      });

      await controller.findAll({
        customerId: "cust-123",
        status: "pending",
      });

      expect(mockSubscriptionsService.findAll).toHaveBeenCalledWith({
        customerId: "cust-123",
        status: "pending",
      });
    });

    it("should return empty list when no matches", async () => {
      mockSubscriptionsService.findAll.mockResolvedValue({
        data: [],
        cursor: null,
        hasMore: false,
      });

      const result = await controller.findAll({});

      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
    });
  });
});
