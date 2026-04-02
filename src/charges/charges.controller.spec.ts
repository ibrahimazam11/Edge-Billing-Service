import { Test } from "@nestjs/testing";
import { HttpStatus } from "@nestjs/common";
import { ChargesController } from "./charges.controller";
import { ChargesService } from "./charges.service";
import { BillingException } from "../common/exceptions/billing.exception";

describe("ChargesController", () => {
  let controller: ChargesController;
  let mockChargesService: {
    createOneTimeCharge: jest.Mock;
  };

  const mockResponse = {
    charge: {
      id: "charge-uuid-1",
      invoiceId: "inv-uuid-1",
      customerId: "cust-uuid-1",
      paymentMethodId: "pm-uuid-1",
      amountCents: 5000,
      currency: "usd",
      status: "succeeded",
      stripePaymentIntentId: "pi_stripe_123",
      idempotencyKey: "idem-key-1",
      failureReason: null,
      attemptNumber: 1,
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    invoice: {
      id: "inv-uuid-1",
      customerId: "cust-uuid-1",
      subscriptionId: null,
      status: "paid",
      totalAmountCents: 5000,
      currency: "usd",
      billingPeriodStart: "2026-02-10T00:00:00.000Z",
      billingPeriodEnd: "2026-02-10T00:00:00.000Z",
      dueDate: "2026-02-10T00:00:00.000Z",
      paidAt: "2026-02-10T00:00:00.000Z",
      voidedAt: null,
      metadata: null,
      lineItems: [
        {
          id: "li-uuid-1",
          invoiceId: "inv-uuid-1",
          type: "one_time_charge",
          description: "Setup fee",
          amountCents: 5000,
          quantity: 1,
          createdAt: "2026-02-10T00:00:00.000Z",
        },
      ],
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
  };

  beforeEach(async () => {
    mockChargesService = {
      createOneTimeCharge: jest.fn().mockResolvedValue(mockResponse),
    };

    const module = await Test.createTestingModule({
      controllers: [ChargesController],
      providers: [{ provide: ChargesService, useValue: mockChargesService }],
    }).compile();

    controller = module.get<ChargesController>(ChargesController);
  });

  describe("createOneTimeCharge", () => {
    const dto = {
      customerId: "cust-uuid-1",
      amountCents: 5000,
      description: "Setup fee",
    };

    it("should return 201 with charge and invoice on success", async () => {
      const result = await controller.createOneTimeCharge(
        dto,
        "idem-key-1",
        "corr-1",
      );

      expect(result).toEqual(mockResponse);
      expect(mockChargesService.createOneTimeCharge).toHaveBeenCalledWith(
        dto,
        "idem-key-1",
        "corr-1",
      );
    });

    it("should throw 400 when x-idempotency-key header is missing", async () => {
      await expect(
        controller.createOneTimeCharge(dto, undefined, "corr-1"),
      ).rejects.toThrow(BillingException);

      try {
        await controller.createOneTimeCharge(dto, undefined, "corr-1");
      } catch (error) {
        expect((error as BillingException).getStatus()).toBe(
          HttpStatus.BAD_REQUEST,
        );
      }
    });

    it("should throw 400 when x-idempotency-key header is empty string", async () => {
      await expect(
        controller.createOneTimeCharge(dto, "", "corr-1"),
      ).rejects.toThrow(BillingException);
    });

    it("should use default correlation ID when header not provided", async () => {
      await controller.createOneTimeCharge(dto, "idem-key-1", undefined);

      expect(mockChargesService.createOneTimeCharge).toHaveBeenCalledWith(
        dto,
        "idem-key-1",
        "no-correlation-id",
      );
    });

    it("should pass through service exceptions", async () => {
      mockChargesService.createOneTimeCharge.mockRejectedValue(
        new BillingException("Customer not found", HttpStatus.NOT_FOUND),
      );

      await expect(
        controller.createOneTimeCharge(dto, "idem-key-1", "corr-1"),
      ).rejects.toThrow(BillingException);
    });
  });
});
