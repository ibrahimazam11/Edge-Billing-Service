import { Test } from "@nestjs/testing";
import { PaymentMethodsService } from "./payment-methods.service";
import { PaymentMethodsRepository } from "./payment-methods.repository";
import { GatewayAssignmentsRepository } from "./gateway-assignments.repository";
import { GatewayRegistry } from "../gateway/gateway.registry";
import type { PaymentGateway } from "../gateway/gateway.interface";
import { CustomersService } from "../customers/customers.service";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import { PaymentMethodNotFoundException } from "../common/exceptions/payment-method-not-found.exception";
import { BusinessRuleViolationException } from "../common/exceptions/billing.exception";
import { GatewayProvider } from "../common/enums/gateway-provider.enum";

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

const makePaymentMethodRow = (overrides = {}) => ({
  id: "pm-uuid-1",
  customerId: "cust-uuid-1",
  stripePaymentMethodId: "pm_stripe_1",
  type: "card",
  isDefault: false,
  lastFour: "4242",
  brand: "visa",
  bankName: null,
  fingerprint: null,
  expiryMonth: 12,
  expiryYear: 2027,
  metadata: null,
  fallbackOrder: null,
  gatewayProvider: "stripe",
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const makeGatewayResult = (overrides = {}) => ({
  id: "pm_stripe_1",
  customerId: "cus_stripe_1",
  type: "card",
  last4: "4242",
  brand: "visa",
  bankName: null,
  expiryMonth: 12,
  expiryYear: 2027,
  isDefault: false,
  fingerprint: null,
  ...overrides,
});

const makeGatewayAssignmentRow = (overrides = {}) => ({
  id: "ga-1",
  customerId: "cust-uuid-1",
  gatewayProvider: "adyen",
  gatewayCustomerId: "ADYEN_SHOPPER_123",
  metadata: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

describe("PaymentMethodsService", () => {
  let service: PaymentMethodsService;
  let repo: jest.Mocked<PaymentMethodsRepository>;
  let mockGatewayAssignmentsRepo: {
    findByCustomer: jest.Mock;
    findByCustomerAndProvider: jest.Mock;
  };

  let mockGateway: jest.Mocked<
    Pick<
      PaymentGateway,
      | "attachPaymentMethod"
      | "detachPaymentMethod"
      | "setDefaultPaymentMethod"
      | "listPaymentMethods"
    >
  >;
  let mockGatewayRegistry: { getAdapter: jest.Mock };
  let mockCustomersService: { findById: jest.Mock };

  beforeEach(async () => {
    repo = {
      findById: jest.fn(),
      findByIdAndCustomer: jest.fn(),
      findActiveByCustomer: jest.fn(),
      findAllByCustomer: jest.fn(),
      getDefaultPaymentMethod: jest.fn(),
      getOrderedByCustomer: jest.fn(),
      findNextDefault: jest.fn(),
      create: jest.fn(),
      updateDefault: jest.fn(),
      updateStatus: jest.fn(),
      updateFallbackOrder: jest.fn(),
      clearDefaults: jest.fn(),
    } as unknown as jest.Mocked<PaymentMethodsRepository>;

    mockGatewayAssignmentsRepo = {
      findByCustomer: jest.fn().mockResolvedValue([]),
      findByCustomerAndProvider: jest.fn().mockResolvedValue(null),
    };

    mockGateway = {
      attachPaymentMethod: jest.fn(),
      detachPaymentMethod: jest.fn(),
      setDefaultPaymentMethod: jest.fn(),
      listPaymentMethods: jest.fn(),
    };

    mockGatewayRegistry = {
      getAdapter: jest.fn().mockReturnValue(mockGateway),
    };

    mockCustomersService = {
      findById: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        PaymentMethodsService,
        { provide: PaymentMethodsRepository, useValue: repo },
        {
          provide: GatewayAssignmentsRepository,
          useValue: mockGatewayAssignmentsRepo,
        },
        { provide: GatewayRegistry, useValue: mockGatewayRegistry },
        { provide: CustomersService, useValue: mockCustomersService },
      ],
    }).compile();

    service = module.get<PaymentMethodsService>(PaymentMethodsService);
  });

  describe("attach", () => {
    it("should attach a payment method successfully (Stripe default)", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      // resolveCustomerGateway — no assignment, defaults to Stripe
      mockGatewayAssignmentsRepo.findByCustomer.mockResolvedValueOnce([]);
      mockGateway.attachPaymentMethod.mockResolvedValue(makeGatewayResult());
      // has existing active methods
      repo.findActiveByCustomer.mockResolvedValueOnce(makePaymentMethodRow());
      repo.create.mockResolvedValueOnce(makePaymentMethodRow());

      const result = await service.attach("cust-uuid-1", {
        paymentMethodId: "pm_stripe_1",
      });

      expect(result.id).toBe("pm-uuid-1");
      expect(result.type).toBe("card");
      expect(mockGatewayRegistry.getAdapter).toHaveBeenCalledWith(
        GatewayProvider.Stripe,
      );
      expect(mockGateway.attachPaymentMethod).toHaveBeenCalledWith(
        "pm_stripe_1",
        "cus_stripe_1",
      );
      expect(mockGateway.setDefaultPaymentMethod).not.toHaveBeenCalled();
    });

    it("should auto-set default when attaching first payment method", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      mockGatewayAssignmentsRepo.findByCustomer.mockResolvedValueOnce([]);
      mockGateway.attachPaymentMethod.mockResolvedValue(makeGatewayResult());
      mockGateway.setDefaultPaymentMethod.mockResolvedValue({
        id: "cus_stripe_1",
        email: "test@example.com",
        name: "Test User",
        metadata: {},
        createdAt: new Date(),
        defaultPaymentMethodId: null,
      });
      // no existing active methods
      repo.findActiveByCustomer.mockResolvedValueOnce(null);
      repo.create.mockResolvedValueOnce(
        makePaymentMethodRow({ isDefault: true }),
      );

      const result = await service.attach("cust-uuid-1", {
        paymentMethodId: "pm_stripe_1",
      });

      expect(result.isDefault).toBe(true);
      expect(mockGateway.setDefaultPaymentMethod).toHaveBeenCalledWith(
        "cus_stripe_1",
        "pm_stripe_1",
      );
    });

    it("should throw CustomerNotFoundException when customer not found", async () => {
      mockCustomersService.findById.mockResolvedValue(null);

      await expect(
        service.attach("non-existent", { paymentMethodId: "pm_1" }),
      ).rejects.toThrow(CustomerNotFoundException);
    });

    it("should throw BusinessRuleViolationException when Stripe customer has no stripeCustomerId", async () => {
      mockCustomersService.findById.mockResolvedValue(
        makeCustomerResponse({ stripeCustomerId: null }),
      );
      mockGatewayAssignmentsRepo.findByCustomer.mockResolvedValueOnce([]);

      await expect(
        service.attach("cust-uuid-1", { paymentMethodId: "pm_stripe_1" }),
      ).rejects.toThrow(BusinessRuleViolationException);
    });

    it("should propagate gateway errors on Stripe attach failure", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      mockGatewayAssignmentsRepo.findByCustomer.mockResolvedValueOnce([]);
      mockGateway.attachPaymentMethod.mockRejectedValue(
        new Error("Invalid payment method"),
      );

      await expect(
        service.attach("cust-uuid-1", { paymentMethodId: "pm_invalid" }),
      ).rejects.toThrow("Invalid payment method");
    });

    it("should route to Adyen adapter when customer has Adyen gateway assignment", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      // resolveCustomerGateway — Adyen assignment
      mockGatewayAssignmentsRepo.findByCustomer.mockResolvedValueOnce([
        makeGatewayAssignmentRow(),
      ]);
      // resolveGatewayCustomerId — Adyen assignment
      mockGatewayAssignmentsRepo.findByCustomerAndProvider.mockResolvedValueOnce(
        makeGatewayAssignmentRow(),
      );
      mockGateway.attachPaymentMethod.mockResolvedValue(
        makeGatewayResult({ id: "ADYEN_STORED_PM_001" }),
      );
      // no existing active methods
      repo.findActiveByCustomer.mockResolvedValueOnce(null);
      mockGateway.setDefaultPaymentMethod.mockResolvedValue({
        id: "ADYEN_SHOPPER_123",
        email: "test@example.com",
        name: "Test User",
        metadata: {},
        createdAt: new Date(),
        defaultPaymentMethodId: null,
      });
      repo.create.mockResolvedValueOnce(
        makePaymentMethodRow({
          gatewayProvider: "adyen",
          stripePaymentMethodId: "ADYEN_STORED_PM_001",
          isDefault: true,
        }),
      );

      const result = await service.attach("cust-uuid-1", {
        paymentMethodId: "ADYEN_STORED_PM_001",
      });

      expect(result.gatewayProvider).toBe(GatewayProvider.Adyen);
      expect(mockGatewayRegistry.getAdapter).toHaveBeenCalledWith(
        GatewayProvider.Adyen,
      );
      expect(mockGateway.attachPaymentMethod).toHaveBeenCalledWith(
        "ADYEN_STORED_PM_001",
        "ADYEN_SHOPPER_123",
      );
    });

    it("should throw BusinessRuleViolationException when Adyen gateway assignment missing for customer ID resolution", async () => {
      mockCustomersService.findById.mockResolvedValue(
        makeCustomerResponse({ stripeCustomerId: null }),
      );
      mockGatewayAssignmentsRepo.findByCustomer.mockResolvedValueOnce([
        makeGatewayAssignmentRow(),
      ]);
      mockGatewayAssignmentsRepo.findByCustomerAndProvider.mockResolvedValueOnce(
        null,
      );

      await expect(
        service.attach("cust-uuid-1", { paymentMethodId: "pm_1" }),
      ).rejects.toThrow(BusinessRuleViolationException);
    });

    it("should store gatewayProvider on inserted payment method record", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      mockGatewayAssignmentsRepo.findByCustomer.mockResolvedValueOnce([]);
      mockGateway.attachPaymentMethod.mockResolvedValue(makeGatewayResult());
      repo.findActiveByCustomer.mockResolvedValueOnce(makePaymentMethodRow());
      repo.create.mockResolvedValueOnce(makePaymentMethodRow());

      await service.attach("cust-uuid-1", {
        paymentMethodId: "pm_stripe_1",
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          gatewayProvider: GatewayProvider.Stripe,
        }),
      );
    });

    it("rejects Stripe bank_account PMs — must go through SetupIntent flow for mandate", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      mockGatewayAssignmentsRepo.findByCustomer.mockResolvedValueOnce([]);
      mockGateway.attachPaymentMethod.mockResolvedValue(
        makeGatewayResult({ type: "us_bank_account" }),
      );

      await expect(
        service.attach("cust-uuid-1", { paymentMethodId: "pm_bank_1" }),
      ).rejects.toThrow(BusinessRuleViolationException);

      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe("detach", () => {
    it("should detach a non-default payment method successfully", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      repo.findByIdAndCustomer.mockResolvedValueOnce(
        makePaymentMethodRow({ isDefault: false }),
      );
      mockGateway.detachPaymentMethod.mockResolvedValue(makeGatewayResult());

      await service.detach("cust-uuid-1", "pm-uuid-1");

      expect(mockGatewayRegistry.getAdapter).toHaveBeenCalledWith(
        GatewayProvider.Stripe,
      );
      expect(mockGateway.detachPaymentMethod).toHaveBeenCalledWith(
        "pm_stripe_1",
      );
      expect(mockGateway.setDefaultPaymentMethod).not.toHaveBeenCalled();
      expect(repo.updateStatus).toHaveBeenCalledWith("pm-uuid-1", "detached", {
        isDefault: false,
      });
    });

    it("should promote oldest active method when detaching default", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      repo.findByIdAndCustomer.mockResolvedValueOnce(
        makePaymentMethodRow({ isDefault: true }),
      );
      mockGateway.detachPaymentMethod.mockResolvedValue(makeGatewayResult());
      repo.findNextDefault.mockResolvedValueOnce(
        makePaymentMethodRow({
          id: "pm-uuid-2",
          stripePaymentMethodId: "pm_stripe_2",
        }),
      );
      mockGateway.setDefaultPaymentMethod.mockResolvedValue({
        id: "cus_stripe_1",
        email: "test@example.com",
        name: "Test User",
        metadata: {},
        createdAt: new Date(),
        defaultPaymentMethodId: null,
      });
      repo.updateDefault.mockResolvedValueOnce(
        makePaymentMethodRow({ id: "pm-uuid-2", isDefault: true }),
      );

      await service.detach("cust-uuid-1", "pm-uuid-1");

      expect(mockGateway.setDefaultPaymentMethod).toHaveBeenCalledWith(
        "cus_stripe_1",
        "pm_stripe_2",
      );
      expect(repo.updateDefault).toHaveBeenCalledWith("pm-uuid-2", true);
    });

    it("should detach last default method without promotion", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      repo.findByIdAndCustomer.mockResolvedValueOnce(
        makePaymentMethodRow({ isDefault: true }),
      );
      mockGateway.detachPaymentMethod.mockResolvedValue(makeGatewayResult());
      repo.findNextDefault.mockResolvedValueOnce(null);

      await service.detach("cust-uuid-1", "pm-uuid-1");

      expect(mockGateway.setDefaultPaymentMethod).not.toHaveBeenCalled();
      expect(repo.updateDefault).not.toHaveBeenCalled();
    });

    it("should throw PaymentMethodNotFoundException when not found", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      repo.findByIdAndCustomer.mockResolvedValueOnce(null);

      await expect(
        service.detach("cust-uuid-1", "non-existent"),
      ).rejects.toThrow(PaymentMethodNotFoundException);
    });

    it("should throw CustomerNotFoundException when customer not found", async () => {
      mockCustomersService.findById.mockResolvedValue(null);

      await expect(service.detach("non-existent", "pm-uuid-1")).rejects.toThrow(
        CustomerNotFoundException,
      );
    });

    it("should route detach to Adyen adapter when PM has adyen gatewayProvider (non-default)", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      repo.findByIdAndCustomer.mockResolvedValueOnce(
        makePaymentMethodRow({
          isDefault: false,
          gatewayProvider: "adyen",
          stripePaymentMethodId: "ADYEN_STORED_PM_001",
        }),
      );
      mockGateway.detachPaymentMethod.mockResolvedValue(makeGatewayResult());

      await service.detach("cust-uuid-1", "pm-uuid-1");

      expect(mockGatewayRegistry.getAdapter).toHaveBeenCalledWith(
        GatewayProvider.Adyen,
      );
      expect(mockGateway.detachPaymentMethod).toHaveBeenCalledWith(
        "ADYEN_STORED_PM_001",
      );
      expect(mockGateway.setDefaultPaymentMethod).not.toHaveBeenCalled();
    });

    it("should resolve gatewayCustomerId when detaching default Adyen PM with next default available", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      repo.findByIdAndCustomer.mockResolvedValueOnce(
        makePaymentMethodRow({
          isDefault: true,
          gatewayProvider: "adyen",
          stripePaymentMethodId: "ADYEN_STORED_PM_001",
        }),
      );
      mockGateway.detachPaymentMethod.mockResolvedValue(makeGatewayResult());
      repo.findNextDefault.mockResolvedValueOnce(
        makePaymentMethodRow({
          id: "pm-uuid-2",
          stripePaymentMethodId: "ADYEN_STORED_PM_002",
          gatewayProvider: "adyen",
        }),
      );
      // resolveGatewayCustomerId — Adyen assignment
      mockGatewayAssignmentsRepo.findByCustomerAndProvider.mockResolvedValueOnce(
        makeGatewayAssignmentRow(),
      );
      mockGateway.setDefaultPaymentMethod.mockResolvedValue({
        id: "ADYEN_SHOPPER_123",
        email: "test@example.com",
        name: "Test User",
        metadata: {},
        createdAt: new Date(),
        defaultPaymentMethodId: null,
      });
      repo.updateDefault.mockResolvedValueOnce(
        makePaymentMethodRow({ id: "pm-uuid-2", isDefault: true }),
      );

      await service.detach("cust-uuid-1", "pm-uuid-1");

      expect(mockGatewayRegistry.getAdapter).toHaveBeenCalledWith(
        GatewayProvider.Adyen,
      );
      expect(mockGateway.setDefaultPaymentMethod).toHaveBeenCalledWith(
        "ADYEN_SHOPPER_123",
        "ADYEN_STORED_PM_002",
      );
    });
  });

  describe("setDefault", () => {
    it("should set a new default payment method", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      repo.findByIdAndCustomer.mockResolvedValueOnce(makePaymentMethodRow());
      mockGateway.setDefaultPaymentMethod.mockResolvedValue({
        id: "cus_stripe_1",
        email: "test@example.com",
        name: "Test User",
        metadata: {},
        createdAt: new Date(),
        defaultPaymentMethodId: null,
      });
      repo.clearDefaults.mockResolvedValueOnce(undefined);
      repo.updateDefault.mockResolvedValueOnce(
        makePaymentMethodRow({ isDefault: true }),
      );

      const result = await service.setDefault("cust-uuid-1", "pm-uuid-1");

      expect(result.isDefault).toBe(true);
      expect(mockGatewayRegistry.getAdapter).toHaveBeenCalledWith(
        GatewayProvider.Stripe,
      );
      expect(mockGateway.setDefaultPaymentMethod).toHaveBeenCalledWith(
        "cus_stripe_1",
        "pm_stripe_1",
      );
      expect(repo.clearDefaults).toHaveBeenCalledWith("cust-uuid-1");
      expect(repo.updateDefault).toHaveBeenCalledWith("pm-uuid-1", true);
    });

    it("should throw PaymentMethodNotFoundException when not found", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      repo.findByIdAndCustomer.mockResolvedValueOnce(null);

      await expect(
        service.setDefault("cust-uuid-1", "non-existent"),
      ).rejects.toThrow(PaymentMethodNotFoundException);
    });

    it("should throw PaymentMethodNotFoundException for detached method", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      repo.findByIdAndCustomer.mockResolvedValueOnce(null);

      await expect(
        service.setDefault("cust-uuid-1", "pm-detached"),
      ).rejects.toThrow(PaymentMethodNotFoundException);
    });

    it("should throw CustomerNotFoundException when customer not found", async () => {
      mockCustomersService.findById.mockResolvedValue(null);

      await expect(
        service.setDefault("non-existent", "pm-uuid-1"),
      ).rejects.toThrow(CustomerNotFoundException);
    });

    it("should route setDefault to Adyen adapter when PM has adyen gatewayProvider", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      repo.findByIdAndCustomer.mockResolvedValueOnce(
        makePaymentMethodRow({
          gatewayProvider: "adyen",
          stripePaymentMethodId: "ADYEN_STORED_PM_001",
        }),
      );
      // resolveGatewayCustomerId — Adyen assignment
      mockGatewayAssignmentsRepo.findByCustomerAndProvider.mockResolvedValueOnce(
        makeGatewayAssignmentRow(),
      );
      mockGateway.setDefaultPaymentMethod.mockResolvedValue({
        id: "ADYEN_SHOPPER_123",
        email: "test@example.com",
        name: "Test User",
        metadata: {},
        createdAt: new Date(),
        defaultPaymentMethodId: null,
      });
      repo.clearDefaults.mockResolvedValueOnce(undefined);
      repo.updateDefault.mockResolvedValueOnce(
        makePaymentMethodRow({
          isDefault: true,
          gatewayProvider: "adyen",
          stripePaymentMethodId: "ADYEN_STORED_PM_001",
        }),
      );

      const result = await service.setDefault("cust-uuid-1", "pm-uuid-1");

      expect(result.isDefault).toBe(true);
      expect(mockGatewayRegistry.getAdapter).toHaveBeenCalledWith(
        GatewayProvider.Adyen,
      );
      expect(mockGateway.setDefaultPaymentMethod).toHaveBeenCalledWith(
        "ADYEN_SHOPPER_123",
        "ADYEN_STORED_PM_001",
      );
    });
  });

  describe("findAll", () => {
    it("should return paginated active payment methods", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      repo.findAllByCustomer.mockResolvedValueOnce([
        makePaymentMethodRow(),
        makePaymentMethodRow({ id: "pm-uuid-2" }),
      ]);

      const result = await service.findAll("cust-uuid-1", { limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
    });

    it("should handle cursor-based pagination with hasMore", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      repo.findAllByCustomer.mockResolvedValueOnce([
        makePaymentMethodRow({ id: "pm-1" }),
        makePaymentMethodRow({ id: "pm-2" }),
        makePaymentMethodRow({ id: "pm-3" }),
      ]);

      const result = await service.findAll("cust-uuid-1", { limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe("pm-2");
    });

    it("should return empty result when no payment methods", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      repo.findAllByCustomer.mockResolvedValueOnce([]);

      const result = await service.findAll("cust-uuid-1", { limit: 20 });

      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
    });

    it("should throw CustomerNotFoundException when customer not found", async () => {
      mockCustomersService.findById.mockResolvedValue(null);

      await expect(
        service.findAll("non-existent", { limit: 20 }),
      ).rejects.toThrow(CustomerNotFoundException);
    });
  });

  describe("getDefaultPaymentMethod", () => {
    it("should return the default active payment method", async () => {
      repo.getDefaultPaymentMethod.mockResolvedValueOnce(
        makePaymentMethodRow({ isDefault: true }),
      );

      const result = await service.getDefaultPaymentMethod("cust-uuid-1");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("pm-uuid-1");
      expect(result!.isDefault).toBe(true);
      expect(result!.stripePaymentMethodId).toBe("pm_stripe_1");
    });

    it("should return null when no default payment method exists", async () => {
      repo.getDefaultPaymentMethod.mockResolvedValueOnce(null);

      const result = await service.getDefaultPaymentMethod("cust-uuid-1");

      expect(result).toBeNull();
    });

    it("should return null when default method is detached", async () => {
      repo.getDefaultPaymentMethod.mockResolvedValueOnce(null);

      const result = await service.getDefaultPaymentMethod("cust-uuid-1");

      expect(result).toBeNull();
    });
  });

  describe("getOrderedPaymentMethods", () => {
    it("should return payment methods ordered: default first, then fallbackOrder ASC, NULLS LAST", async () => {
      const rows = [
        makePaymentMethodRow({
          id: "pm-A",
          isDefault: true,
          fallbackOrder: null,
        }),
        makePaymentMethodRow({
          id: "pm-B",
          isDefault: false,
          fallbackOrder: 1,
        }),
        makePaymentMethodRow({
          id: "pm-C",
          isDefault: false,
          fallbackOrder: 2,
        }),
        makePaymentMethodRow({
          id: "pm-D",
          isDefault: false,
          fallbackOrder: null,
        }),
      ];
      repo.getOrderedByCustomer.mockResolvedValueOnce(rows);

      const result = await service.getOrderedPaymentMethods("cust-uuid-1");

      expect(result).toHaveLength(4);
      expect(result[0].id).toBe("pm-A");
      expect(result[0].isDefault).toBe(true);
      expect(result[1].id).toBe("pm-B");
      expect(result[1].fallbackOrder).toBe(1);
      expect(result[2].id).toBe("pm-C");
      expect(result[2].fallbackOrder).toBe(2);
      expect(result[3].id).toBe("pm-D");
      expect(result[3].fallbackOrder).toBeNull();
    });

    it("should return single default PM when only one active payment method exists", async () => {
      repo.getOrderedByCustomer.mockResolvedValueOnce([
        makePaymentMethodRow({ id: "pm-A", isDefault: true }),
      ]);

      const result = await service.getOrderedPaymentMethods("cust-uuid-1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("pm-A");
      expect(result[0].isDefault).toBe(true);
    });

    it("should return empty array when no active payment methods exist", async () => {
      repo.getOrderedByCustomer.mockResolvedValueOnce([]);

      const result = await service.getOrderedPaymentMethods("cust-uuid-1");

      expect(result).toHaveLength(0);
      expect(result).toEqual([]);
    });

    it("should sort PMs with NULL fallbackOrder after numbered ones", async () => {
      const rows = [
        makePaymentMethodRow({
          id: "pm-1",
          isDefault: false,
          fallbackOrder: 1,
        }),
        makePaymentMethodRow({
          id: "pm-2",
          isDefault: false,
          fallbackOrder: null,
        }),
      ];
      repo.getOrderedByCustomer.mockResolvedValueOnce(rows);

      const result = await service.getOrderedPaymentMethods("cust-uuid-1");

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("pm-1");
      expect(result[0].fallbackOrder).toBe(1);
      expect(result[1].id).toBe("pm-2");
      expect(result[1].fallbackOrder).toBeNull();
    });

    it("should include fallbackOrder in response DTOs", async () => {
      const rows = [
        makePaymentMethodRow({
          id: "pm-A",
          isDefault: true,
          fallbackOrder: null,
        }),
        makePaymentMethodRow({
          id: "pm-B",
          isDefault: false,
          fallbackOrder: 3,
        }),
      ];
      repo.getOrderedByCustomer.mockResolvedValueOnce(rows);

      const result = await service.getOrderedPaymentMethods("cust-uuid-1");

      expect(result[0].fallbackOrder).toBeNull();
      expect(result[1].fallbackOrder).toBe(3);
    });
  });

  describe("updateFallbackOrder", () => {
    it("should update fallbackOrder to integer and return updated PM", async () => {
      repo.findByIdAndCustomer.mockResolvedValueOnce(makePaymentMethodRow());
      repo.updateFallbackOrder.mockResolvedValueOnce(
        makePaymentMethodRow({ fallbackOrder: 2 }),
      );

      const result = await service.updateFallbackOrder(
        "cust-uuid-1",
        "pm-uuid-1",
        2,
      );

      expect(result.id).toBe("pm-uuid-1");
      expect(result.fallbackOrder).toBe(2);
      expect(repo.updateFallbackOrder).toHaveBeenCalledWith("pm-uuid-1", 2);
    });

    it("should update fallbackOrder to null and return PM with null fallbackOrder", async () => {
      repo.findByIdAndCustomer.mockResolvedValueOnce(
        makePaymentMethodRow({ fallbackOrder: 3 }),
      );
      repo.updateFallbackOrder.mockResolvedValueOnce(
        makePaymentMethodRow({ fallbackOrder: null }),
      );

      const result = await service.updateFallbackOrder(
        "cust-uuid-1",
        "pm-uuid-1",
        null,
      );

      expect(result.id).toBe("pm-uuid-1");
      expect(result.fallbackOrder).toBeNull();
      expect(repo.updateFallbackOrder).toHaveBeenCalledWith("pm-uuid-1", null);
    });

    it("should throw PaymentMethodNotFoundException for non-existent PM", async () => {
      repo.findByIdAndCustomer.mockResolvedValueOnce(null);

      await expect(
        service.updateFallbackOrder("cust-uuid-1", "non-existent", 1),
      ).rejects.toThrow(PaymentMethodNotFoundException);
    });

    it("should throw PaymentMethodNotFoundException when PM belongs to different customer", async () => {
      repo.findByIdAndCustomer.mockResolvedValueOnce(null);

      await expect(
        service.updateFallbackOrder("other-cust", "pm-uuid-1", 1),
      ).rejects.toThrow(PaymentMethodNotFoundException);
    });

    it("should throw PaymentMethodNotFoundException for detached PM", async () => {
      repo.findByIdAndCustomer.mockResolvedValueOnce(null);

      await expect(
        service.updateFallbackOrder("cust-uuid-1", "pm-detached", 1),
      ).rejects.toThrow(PaymentMethodNotFoundException);
    });

    it("should set fallbackOrder to zero", async () => {
      repo.findByIdAndCustomer.mockResolvedValueOnce(makePaymentMethodRow());
      repo.updateFallbackOrder.mockResolvedValueOnce(
        makePaymentMethodRow({ fallbackOrder: 0 }),
      );

      const result = await service.updateFallbackOrder(
        "cust-uuid-1",
        "pm-uuid-1",
        0,
      );

      expect(result.fallbackOrder).toBe(0);
    });
  });

  describe("getActivePaymentMethodById", () => {
    it("should return DTO with all fields including gatewayProvider when active PM belongs to customer", async () => {
      const row = makePaymentMethodRow({
        id: "pm-target",
        customerId: "cust-uuid-1",
        stripePaymentMethodId: "pm_stripe_target",
        isDefault: false,
        lastFour: "1234",
        brand: "mastercard",
        fallbackOrder: 2,
        gatewayProvider: "stripe",
      });
      repo.findByIdAndCustomer.mockResolvedValueOnce(row);

      const result = await service.getActivePaymentMethodById(
        "cust-uuid-1",
        "pm-target",
      );

      expect(result.id).toBe("pm-target");
      expect(result.customerId).toBe("cust-uuid-1");
      expect(result.stripePaymentMethodId).toBe("pm_stripe_target");
      expect(result.isDefault).toBe(false);
      expect(result.lastFour).toBe("1234");
      expect(result.brand).toBe("mastercard");
      expect(result.fallbackOrder).toBe(2);
      expect(result.gatewayProvider).toBe(GatewayProvider.Stripe);
      expect(result.status).toBe("active");
      expect(result.type).toBe("card");
      expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(result.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("should throw PaymentMethodNotFoundException when PM not found", async () => {
      repo.findByIdAndCustomer.mockResolvedValueOnce(null);

      await expect(
        service.getActivePaymentMethodById("cust-uuid-1", "non-existent"),
      ).rejects.toThrow(PaymentMethodNotFoundException);
    });

    it("should throw PaymentMethodNotFoundException when PM belongs to different customer", async () => {
      repo.findByIdAndCustomer.mockResolvedValueOnce(null);

      await expect(
        service.getActivePaymentMethodById("other-customer", "pm-uuid-1"),
      ).rejects.toThrow(PaymentMethodNotFoundException);
    });

    it("should throw PaymentMethodNotFoundException when PM is detached", async () => {
      repo.findByIdAndCustomer.mockResolvedValueOnce(null);

      await expect(
        service.getActivePaymentMethodById("cust-uuid-1", "pm-detached"),
      ).rejects.toThrow(PaymentMethodNotFoundException);
    });

    it("should return default PM with correct isDefault flag", async () => {
      const row = makePaymentMethodRow({
        id: "pm-default",
        isDefault: true,
        fallbackOrder: null,
      });
      repo.findByIdAndCustomer.mockResolvedValueOnce(row);

      const result = await service.getActivePaymentMethodById(
        "cust-uuid-1",
        "pm-default",
      );

      expect(result.id).toBe("pm-default");
      expect(result.isDefault).toBe(true);
      expect(result.fallbackOrder).toBeNull();
    });
  });

  describe("resolveCustomerGateway", () => {
    it("should return Stripe when no gateway assignment exists", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      mockGatewayAssignmentsRepo.findByCustomer.mockResolvedValueOnce([]);
      mockGateway.attachPaymentMethod.mockResolvedValue(makeGatewayResult());
      repo.findActiveByCustomer.mockResolvedValueOnce(makePaymentMethodRow());
      repo.create.mockResolvedValueOnce(makePaymentMethodRow());

      await service.attach("cust-uuid-1", { paymentMethodId: "pm_stripe_1" });

      expect(mockGatewayRegistry.getAdapter).toHaveBeenCalledWith(
        GatewayProvider.Stripe,
      );
    });

    it("should return Adyen when gateway assignment exists for customer", async () => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      mockGatewayAssignmentsRepo.findByCustomer.mockResolvedValueOnce([
        makeGatewayAssignmentRow(),
      ]);
      mockGatewayAssignmentsRepo.findByCustomerAndProvider.mockResolvedValueOnce(
        makeGatewayAssignmentRow(),
      );
      mockGateway.attachPaymentMethod.mockResolvedValue(makeGatewayResult());
      repo.findActiveByCustomer.mockResolvedValueOnce(makePaymentMethodRow());
      repo.create.mockResolvedValueOnce(
        makePaymentMethodRow({ gatewayProvider: "adyen" }),
      );

      await service.attach("cust-uuid-1", { paymentMethodId: "pm_1" });

      expect(mockGatewayRegistry.getAdapter).toHaveBeenCalledWith(
        GatewayProvider.Adyen,
      );
    });
  });

  describe("confirmSetupAndAttach", () => {
    // Attach SetupIntent-flow mocks onto the shared mockGateway. They live on the
    // SetupIntentGateway interface, which is cast-to via `as unknown` in the service.
    const setupGatewayMocks = () => {
      const gateway = mockGateway as unknown as Record<string, jest.Mock>;
      gateway.retrieveSetupIntent = jest.fn();
      gateway.confirmSetup = jest.fn();
      return gateway;
    };

    beforeEach(() => {
      mockCustomersService.findById.mockResolvedValue(makeCustomerResponse());
      mockGatewayAssignmentsRepo.findByCustomerAndProvider.mockResolvedValue({
        gatewayCustomerId: "cus_stripe_1",
      });
      repo.getDefaultPaymentMethod.mockResolvedValue(null); // no prior default
      mockGateway.setDefaultPaymentMethod.mockResolvedValue(undefined as never);
      mockGateway.listPaymentMethods.mockResolvedValue([]);
    });

    it("persists mandate_id in metadata for bank_account with mandate", async () => {
      const gateway = setupGatewayMocks();
      gateway.retrieveSetupIntent.mockResolvedValue({
        id: "seti_1",
        status: "succeeded",
        paymentMethodId: "pm_bank_1",
        mandateId: "mandate_abc",
        clientSecret: null,
      });
      mockGateway.listPaymentMethods.mockResolvedValue([
        {
          id: "pm_bank_1",
          type: "us_bank_account",
          last4: "6789",
          brand: null,
          bankName: "Chase",
          expiryMonth: null,
          expiryYear: null,
        } as never,
      ]);
      repo.create.mockResolvedValue(
        makePaymentMethodRow({
          id: "pm-uuid-bank",
          stripePaymentMethodId: "pm_bank_1",
          type: "bank_account",
          bankName: "Chase",
          metadata: { mandate_id: "mandate_abc" },
        }),
      );

      await service.confirmSetupAndAttach("cust-uuid-1", "seti_1");

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stripePaymentMethodId: "pm_bank_1",
          type: "bank_account",
          metadata: { mandate_id: "mandate_abc" },
        }),
      );
    });

    it("persists null metadata for bank_account without mandate", async () => {
      const gateway = setupGatewayMocks();
      gateway.retrieveSetupIntent.mockResolvedValue({
        id: "seti_1",
        status: "succeeded",
        paymentMethodId: "pm_bank_2",
        mandateId: null,
        clientSecret: null,
      });
      mockGateway.listPaymentMethods.mockResolvedValue([
        {
          id: "pm_bank_2",
          type: "us_bank_account",
          last4: "1111",
          brand: null,
          bankName: null,
          expiryMonth: null,
          expiryYear: null,
        } as never,
      ]);
      repo.create.mockResolvedValue(
        makePaymentMethodRow({
          stripePaymentMethodId: "pm_bank_2",
          type: "bank_account",
        }),
      );

      await service.confirmSetupAndAttach("cust-uuid-1", "seti_1");

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stripePaymentMethodId: "pm_bank_2",
          type: "bank_account",
          metadata: null,
        }),
      );
    });

    it("never persists mandate metadata for cards even if mandateId present", async () => {
      const gateway = setupGatewayMocks();
      gateway.retrieveSetupIntent.mockResolvedValue({
        id: "seti_2",
        status: "succeeded",
        paymentMethodId: "pm_card_1",
        // Defensive: cards in our flow shouldn't carry a mandate, but guard anyway.
        mandateId: "mandate_should_be_ignored",
        clientSecret: null,
      });
      mockGateway.listPaymentMethods.mockResolvedValue([
        {
          id: "pm_card_1",
          type: "card",
          last4: "4242",
          brand: "visa",
          bankName: null,
          expiryMonth: 12,
          expiryYear: 2030,
        } as never,
      ]);
      repo.create.mockResolvedValue(
        makePaymentMethodRow({
          stripePaymentMethodId: "pm_card_1",
          type: "card",
        }),
      );

      await service.confirmSetupAndAttach("cust-uuid-1", "seti_2");

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stripePaymentMethodId: "pm_card_1",
          type: "card",
          metadata: null,
        }),
      );
    });

    it("throws when listPaymentMethods does not return the attached PM (no silent mis-typing)", async () => {
      const gateway = setupGatewayMocks();
      gateway.retrieveSetupIntent.mockResolvedValue({
        id: "seti_3",
        status: "succeeded",
        paymentMethodId: "pm_missing",
        mandateId: "mandate_xxx",
        clientSecret: null,
      });
      // Stripe list returns a different PM — find() yields undefined
      mockGateway.listPaymentMethods.mockResolvedValue([
        {
          id: "pm_other",
          type: "card",
          last4: "1111",
          brand: "visa",
          bankName: null,
          expiryMonth: 1,
          expiryYear: 2030,
        } as never,
      ]);

      await expect(
        service.confirmSetupAndAttach("cust-uuid-1", "seti_3"),
      ).rejects.toThrow(BusinessRuleViolationException);

      expect(repo.create).not.toHaveBeenCalled();
    });
  });
});
