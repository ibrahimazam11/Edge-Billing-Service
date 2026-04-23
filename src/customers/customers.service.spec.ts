import { Test } from "@nestjs/testing";
import { CustomersService } from "./customers.service";
import { CustomersRepository } from "./customers.repository";
import { PAYMENT_GATEWAY } from "../gateway/gateway.interface";
import type { PaymentGateway } from "../gateway/gateway.interface";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import type {
  CustomerCreatedPayload,
  CustomerUpdatedPayload,
} from "../integration/sqs/contracts/inbound-events";

const mockCustomerRow = {
  id: "01234567-89ab-7def-0123-456789abcdef",
  monolithCustomerId: "mono-123",
  stripeCustomerId: "cus_stripe_123",
  name: "Test Customer",
  email: "test@example.com",
  status: "active",
  chargeDay: 1,
  isPrepaid: false,
  metadata: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("CustomersService", () => {
  let service: CustomersService;
  let repo: jest.Mocked<CustomersRepository>;
  let mockGateway: jest.Mocked<PaymentGateway>;

  beforeEach(async () => {
    repo = {
      findById: jest.fn(),
      findByMonolithId: jest.fn(),
      findByStripeCustomerId: jest.fn(),
      findAll: jest.fn(),
      search: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<CustomersRepository>;

    mockGateway = {
      createCustomer: jest.fn().mockResolvedValue({
        id: "cus_stripe_123",
        email: "test@example.com",
        name: "Test Customer",
        metadata: {},
        createdAt: new Date(),
        defaultPaymentMethodId: null,
      }),
      updateCustomer: jest.fn().mockResolvedValue({
        id: "cus_stripe_123",
        email: "test@example.com",
        name: "Test Customer",
        metadata: {},
        createdAt: new Date(),
        defaultPaymentMethodId: null,
      }),
      attachPaymentMethod: jest.fn(),
      detachPaymentMethod: jest.fn(),
      setDefaultPaymentMethod: jest.fn(),
      createCharge: jest.fn(),
      createRefund: jest.fn(),
      getCustomer: jest.fn(),
      listPaymentMethods: jest.fn().mockResolvedValue([]),
      getBalanceTransactions: jest.fn(),
      verifyAndParseWebhook: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: CustomersRepository, useValue: repo },
        { provide: PAYMENT_GATEWAY, useValue: mockGateway },
      ],
    }).compile();

    service = module.get<CustomersService>(CustomersService);
  });

  describe("createFromEvent", () => {
    const payload: CustomerCreatedPayload = {
      monolithCustomerId: "mono-123",
      name: "Test Customer",
      email: "test@example.com",
    };

    it("should create a customer and Stripe customer", async () => {
      repo.findByMonolithId.mockResolvedValueOnce(null);
      repo.create.mockResolvedValueOnce(mockCustomerRow);

      const result = await service.createFromEvent(payload, "corr-1");

      expect(mockGateway.createCustomer).toHaveBeenCalledWith({
        email: "test@example.com",
        name: "Test Customer",
        metadata: {
          billingCustomerId: expect.any(String),
          monolithCustomerId: "mono-123",
        },
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          monolithCustomerId: "mono-123",
          stripeCustomerId: "cus_stripe_123",
          name: "Test Customer",
          email: "test@example.com",
          status: "active",
        }),
      );
      expect(result.monolithCustomerId).toBe("mono-123");
      expect(result.stripeCustomerId).toBe("cus_stripe_123");
    });

    it("should return existing customer if monolith ID already exists (idempotent)", async () => {
      repo.findByMonolithId.mockResolvedValueOnce(mockCustomerRow);

      const result = await service.createFromEvent(payload, "corr-2");

      expect(mockGateway.createCustomer).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
      expect(result.id).toBe(mockCustomerRow.id);
    });

    it("should create customer with metadata", async () => {
      repo.findByMonolithId.mockResolvedValueOnce(null);
      repo.create.mockResolvedValueOnce({
        ...mockCustomerRow,
        metadata: { plan: "premium" },
      });

      const payloadWithMeta: CustomerCreatedPayload = {
        ...payload,
        metadata: { plan: "premium" },
      };

      await service.createFromEvent(payloadWithMeta, "corr-3");

      expect(mockGateway.createCustomer).toHaveBeenCalledWith({
        email: "test@example.com",
        name: "Test Customer",
        metadata: {
          plan: "premium",
          billingCustomerId: expect.any(String),
          monolithCustomerId: "mono-123",
        },
      });
    });

    it("should propagate gateway errors", async () => {
      repo.findByMonolithId.mockResolvedValueOnce(null);
      mockGateway.createCustomer.mockRejectedValueOnce(
        new Error("Stripe error"),
      );

      await expect(service.createFromEvent(payload, "corr-4")).rejects.toThrow(
        "Stripe error",
      );
    });
  });

  describe("updateFromEvent", () => {
    const payload: CustomerUpdatedPayload = {
      monolithCustomerId: "mono-123",
      name: "Updated Name",
      email: "updated@example.com",
    };

    it("should update customer and Stripe customer", async () => {
      repo.findByMonolithId.mockResolvedValueOnce(mockCustomerRow);
      repo.update.mockResolvedValueOnce({
        ...mockCustomerRow,
        name: "Updated Name",
        email: "updated@example.com",
      });

      const result = await service.updateFromEvent(payload, "corr-5");

      expect(repo.update).toHaveBeenCalledWith(
        mockCustomerRow.id,
        expect.objectContaining({
          name: "Updated Name",
          email: "updated@example.com",
        }),
      );
      expect(mockGateway.updateCustomer).toHaveBeenCalledWith(
        "cus_stripe_123",
        {
          email: "updated@example.com",
          name: "Updated Name",
          metadata: undefined,
        },
      );
      expect(result.name).toBe("Updated Name");
    });

    it("should throw CustomerNotFoundException when customer does not exist", async () => {
      repo.findByMonolithId.mockResolvedValueOnce(null);

      await expect(service.updateFromEvent(payload, "corr-6")).rejects.toThrow(
        CustomerNotFoundException,
      );
    });

    it("should skip Stripe update when no stripe_customer_id", async () => {
      const noStripeCustomer = { ...mockCustomerRow, stripeCustomerId: null };
      repo.findByMonolithId.mockResolvedValueOnce(noStripeCustomer);
      repo.update.mockResolvedValueOnce({
        ...noStripeCustomer,
        name: "Updated Name",
      });

      await service.updateFromEvent(payload, "corr-7");

      expect(mockGateway.updateCustomer).not.toHaveBeenCalled();
    });

    it("should update only provided fields", async () => {
      repo.findByMonolithId.mockResolvedValueOnce(mockCustomerRow);
      repo.update.mockResolvedValueOnce({
        ...mockCustomerRow,
        name: "New Name",
      });

      const partialPayload: CustomerUpdatedPayload = {
        monolithCustomerId: "mono-123",
        name: "New Name",
      };

      const result = await service.updateFromEvent(partialPayload, "corr-8");

      expect(result.name).toBe("New Name");
    });
  });

  describe("findById", () => {
    it("should return customer when found", async () => {
      repo.findById.mockResolvedValueOnce(mockCustomerRow);

      const result = await service.findById(mockCustomerRow.id);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(mockCustomerRow.id);
      expect(result!.createdAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("should return null when customer not found", async () => {
      repo.findById.mockResolvedValueOnce(null);

      const result = await service.findById("non-existent-id");

      expect(result).toBeNull();
    });
  });

  describe("findByMonolithId", () => {
    it("should return customer when found by monolith ID", async () => {
      repo.findByMonolithId.mockResolvedValueOnce(mockCustomerRow);

      const result = await service.findByMonolithId("mono-123");

      expect(result).not.toBeNull();
      expect(result!.monolithCustomerId).toBe("mono-123");
    });

    it("should return null when not found", async () => {
      repo.findByMonolithId.mockResolvedValueOnce(null);

      const result = await service.findByMonolithId("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("findAll", () => {
    it("should return paginated results", async () => {
      const rows = [mockCustomerRow, { ...mockCustomerRow, id: "id-2" }];
      repo.findAll.mockResolvedValueOnce(rows);

      const result = await service.findAll({ limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
    });

    it("should indicate hasMore when results exceed limit", async () => {
      const rows = [
        mockCustomerRow,
        { ...mockCustomerRow, id: "id-2" },
        { ...mockCustomerRow, id: "id-3" },
      ];
      repo.findAll.mockResolvedValueOnce(rows);

      const result = await service.findAll({ limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe("id-2");
    });

    it("should filter by status", async () => {
      repo.findAll.mockResolvedValueOnce([mockCustomerRow]);

      const result = await service.findAll({ status: "active" as never });

      expect(result.data).toHaveLength(1);
      expect(repo.findAll).toHaveBeenCalledWith(
        { status: "active", cursor: undefined },
        20,
      );
    });

    it("should support cursor-based pagination", async () => {
      repo.findAll.mockResolvedValueOnce([
        { ...mockCustomerRow, id: "id-after-cursor" },
      ]);

      const result = await service.findAll({
        cursor: "some-cursor-id",
        limit: 20,
      });

      expect(result.data).toHaveLength(1);
      expect(repo.findAll).toHaveBeenCalledWith(
        { status: undefined, cursor: "some-cursor-id" },
        20,
      );
    });

    it("should return empty result when no customers exist", async () => {
      repo.findAll.mockResolvedValueOnce([]);

      const result = await service.findAll({ limit: 20 });

      expect(result.data).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
    });
  });

  describe("createFromEvent — Stripe metadata", () => {
    const payload = {
      monolithCustomerId: "mono-123",
      name: "Test Customer",
      email: "test@example.com",
    };

    it("should pass billingCustomerId in Stripe metadata", async () => {
      repo.findByMonolithId.mockResolvedValueOnce(null);
      repo.create.mockResolvedValueOnce(mockCustomerRow);

      await service.createFromEvent(payload, "corr-meta-1");

      expect(mockGateway.createCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            billingCustomerId: expect.any(String),
          }),
        }),
      );

      // billingCustomerId must be a non-empty UUID string
      const call = mockGateway.createCustomer.mock.calls[0][0];
      expect(call.metadata!.billingCustomerId).toBeTruthy();
      expect(typeof call.metadata!.billingCustomerId).toBe("string");
    });

    it("should pass monolithCustomerId in Stripe metadata", async () => {
      repo.findByMonolithId.mockResolvedValueOnce(null);
      repo.create.mockResolvedValueOnce(mockCustomerRow);

      await service.createFromEvent(payload, "corr-meta-2");

      expect(mockGateway.createCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            monolithCustomerId: "mono-123",
          }),
        }),
      );
    });

    it("should generate billingCustomerId before calling gateway (not null/undefined)", async () => {
      repo.findByMonolithId.mockResolvedValueOnce(null);
      repo.create.mockResolvedValueOnce(mockCustomerRow);

      await service.createFromEvent(payload, "corr-meta-3");

      const call = mockGateway.createCustomer.mock.calls[0][0];
      expect(call.metadata!.billingCustomerId).not.toBeNull();
      expect(call.metadata!.billingCustomerId).not.toBeUndefined();
      expect(call.metadata!.billingCustomerId.length).toBeGreaterThan(0);
    });
  });

  describe("findByStripeCustomerId", () => {
    it("should return customer when found", async () => {
      repo.findByStripeCustomerId.mockResolvedValueOnce(mockCustomerRow);

      const result = await service.findByStripeCustomerId("cus_stripe_123");

      expect(result).not.toBeNull();
      expect(result!.stripeCustomerId).toBe("cus_stripe_123");
      expect(result!.createdAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("should return null when not found", async () => {
      repo.findByStripeCustomerId.mockResolvedValueOnce(null);

      const result = await service.findByStripeCustomerId("cus_nonexistent");

      expect(result).toBeNull();
    });

    it("should call repository findByStripeCustomerId with correct argument", async () => {
      repo.findByStripeCustomerId.mockResolvedValueOnce(null);

      await service.findByStripeCustomerId("cus_test_456");

      expect(repo.findByStripeCustomerId).toHaveBeenCalledWith("cus_test_456");
    });
  });
});
