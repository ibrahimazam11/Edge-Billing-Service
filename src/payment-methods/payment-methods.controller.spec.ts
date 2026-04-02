import { Test } from "@nestjs/testing";
import { PaymentMethodsController } from "./payment-methods.controller";
import { PaymentMethodsService } from "./payment-methods.service";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import { PaymentMethodNotFoundException } from "../common/exceptions/payment-method-not-found.exception";
import type { PaymentMethodResponseDto } from "./dto/payment-method-response.dto";

const mockPaymentMethodResponse: PaymentMethodResponseDto = {
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
};

describe("PaymentMethodsController", () => {
  let controller: PaymentMethodsController;
  let service: jest.Mocked<PaymentMethodsService>;

  beforeEach(async () => {
    const mockService = {
      attach: jest.fn(),
      detach: jest.fn(),
      setDefault: jest.fn(),
      updateFallbackOrder: jest.fn(),
      findAll: jest.fn(),
    };

    const module = await Test.createTestingModule({
      controllers: [PaymentMethodsController],
      providers: [{ provide: PaymentMethodsService, useValue: mockService }],
    }).compile();

    controller = module.get<PaymentMethodsController>(PaymentMethodsController);
    service = module.get(PaymentMethodsService);
  });

  describe("POST /v1/customers/:customerId/payment-methods", () => {
    it("should attach a payment method and return 201", async () => {
      service.attach.mockResolvedValue(mockPaymentMethodResponse);

      const result = await controller.attach("cust-uuid-1", {
        paymentMethodId: "pm_stripe_1",
      });

      expect(result).toEqual(mockPaymentMethodResponse);
      expect(service.attach).toHaveBeenCalledWith(
        "cust-uuid-1",
        { paymentMethodId: "pm_stripe_1" },
        undefined,
      );
    });

    it("should throw CustomerNotFoundException when customer not found", async () => {
      service.attach.mockRejectedValue(
        new CustomerNotFoundException("non-existent"),
      );

      await expect(
        controller.attach("non-existent", { paymentMethodId: "pm_1" }),
      ).rejects.toThrow(CustomerNotFoundException);
    });
  });

  describe("DELETE /v1/customers/:customerId/payment-methods/:pmId", () => {
    it("should detach a payment method and return 204", async () => {
      service.detach.mockResolvedValue(undefined);

      await controller.detach("cust-uuid-1", "pm-uuid-1");

      expect(service.detach).toHaveBeenCalledWith(
        "cust-uuid-1",
        "pm-uuid-1",
        undefined,
      );
    });

    it("should throw PaymentMethodNotFoundException when not found", async () => {
      service.detach.mockRejectedValue(
        new PaymentMethodNotFoundException("non-existent"),
      );

      await expect(
        controller.detach("cust-uuid-1", "non-existent"),
      ).rejects.toThrow(PaymentMethodNotFoundException);
    });
  });

  describe("PUT /v1/customers/:customerId/payment-methods/:pmId/default", () => {
    it("should set default payment method and return 200", async () => {
      service.setDefault.mockResolvedValue(mockPaymentMethodResponse);

      const result = await controller.setDefault("cust-uuid-1", "pm-uuid-1");

      expect(result).toEqual(mockPaymentMethodResponse);
      expect(service.setDefault).toHaveBeenCalledWith(
        "cust-uuid-1",
        "pm-uuid-1",
        undefined,
      );
    });

    it("should throw PaymentMethodNotFoundException when not found", async () => {
      service.setDefault.mockRejectedValue(
        new PaymentMethodNotFoundException("non-existent"),
      );

      await expect(
        controller.setDefault("cust-uuid-1", "non-existent"),
      ).rejects.toThrow(PaymentMethodNotFoundException);
    });
  });

  describe("PUT /v1/customers/:customerId/payment-methods/:pmId/fallback-order", () => {
    it("should update fallback order with integer and return 200", async () => {
      const updatedPm = {
        ...mockPaymentMethodResponse,
        fallbackOrder: 2,
      };
      service.updateFallbackOrder.mockResolvedValue(updatedPm);

      const result = await controller.updateFallbackOrder(
        "cust-uuid-1",
        "pm-uuid-1",
        { fallbackOrder: 2 } as never,
      );

      expect(result).toEqual(updatedPm);
      expect(result.fallbackOrder).toBe(2);
      expect(service.updateFallbackOrder).toHaveBeenCalledWith(
        "cust-uuid-1",
        "pm-uuid-1",
        2,
      );
    });

    it("should clear fallback order with null and return 200", async () => {
      const updatedPm = {
        ...mockPaymentMethodResponse,
        fallbackOrder: null,
      };
      service.updateFallbackOrder.mockResolvedValue(updatedPm);

      const result = await controller.updateFallbackOrder(
        "cust-uuid-1",
        "pm-uuid-1",
        { fallbackOrder: null } as never,
      );

      expect(result).toEqual(updatedPm);
      expect(result.fallbackOrder).toBeNull();
      expect(service.updateFallbackOrder).toHaveBeenCalledWith(
        "cust-uuid-1",
        "pm-uuid-1",
        null,
      );
    });

    it("should throw PaymentMethodNotFoundException for non-existent PM", async () => {
      service.updateFallbackOrder.mockRejectedValue(
        new PaymentMethodNotFoundException("non-existent"),
      );

      await expect(
        controller.updateFallbackOrder("cust-uuid-1", "non-existent", {
          fallbackOrder: 1,
        } as never),
      ).rejects.toThrow(PaymentMethodNotFoundException);
    });

    it("should delegate to service with correct arguments", async () => {
      service.updateFallbackOrder.mockResolvedValue(mockPaymentMethodResponse);

      await controller.updateFallbackOrder("cust-uuid-1", "pm-uuid-1", {
        fallbackOrder: 5,
      } as never);

      expect(service.updateFallbackOrder).toHaveBeenCalledTimes(1);
      expect(service.updateFallbackOrder).toHaveBeenCalledWith(
        "cust-uuid-1",
        "pm-uuid-1",
        5,
      );
    });

    it("should return 404 error shape on non-existent PM", async () => {
      const error = new PaymentMethodNotFoundException("non-existent");
      service.updateFallbackOrder.mockRejectedValue(error);

      try {
        await controller.updateFallbackOrder("cust-uuid-1", "non-existent", {
          fallbackOrder: 1,
        } as never);
        fail("Expected PaymentMethodNotFoundException");
      } catch (e) {
        expect(e).toBeInstanceOf(PaymentMethodNotFoundException);
        expect((e as PaymentMethodNotFoundException).message).toContain(
          "non-existent",
        );
      }
    });
  });

  describe("GET /v1/customers/:customerId/payment-methods", () => {
    it("should return paginated payment methods", async () => {
      const paginatedResult = {
        data: [mockPaymentMethodResponse],
        cursor: null,
        hasMore: false,
      };
      service.findAll.mockResolvedValue(paginatedResult);

      const result = await controller.findAll("cust-uuid-1", { limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(service.findAll).toHaveBeenCalledWith("cust-uuid-1", {
        limit: 20,
      });
    });

    it("should return empty list when no payment methods exist", async () => {
      service.findAll.mockResolvedValue({
        data: [],
        cursor: null,
        hasMore: false,
      });

      const result = await controller.findAll("cust-uuid-1", { limit: 20 });

      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
    });
  });
});
