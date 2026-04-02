import { Test } from "@nestjs/testing";
import { HttpStatus } from "@nestjs/common";
import { OnboardingChargesController } from "./onboarding-charges.controller";
import { ChargesService } from "./charges.service";
import { BillingException } from "../common/exceptions/billing.exception";

describe("OnboardingChargesController", () => {
  let controller: OnboardingChargesController;
  let mockChargesService: {
    createOnboardingCharge: jest.Mock;
  };

  const mockResponse = {
    invoice: {
      id: "inv-uuid-1",
      customerId: "cust-uuid-1",
      subscriptionId: null,
      status: "draft",
      totalAmountCents: 15000,
      currency: "usd",
      billingPeriodStart: "2026-03-01T00:00:00.000Z",
      billingPeriodEnd: "2026-03-01T00:00:00.000Z",
      dueDate: "2026-03-01T00:00:00.000Z",
      paidAt: null,
      voidedAt: null,
      metadata: null,
      lineItems: [
        {
          id: "li-uuid-1",
          invoiceId: "inv-uuid-1",
          type: "onboarding_fee",
          description: "Onboarding implementation fee",
          amountCents: 15000,
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
      createOnboardingCharge: jest.fn().mockResolvedValue(mockResponse),
    };

    const module = await Test.createTestingModule({
      controllers: [OnboardingChargesController],
      providers: [{ provide: ChargesService, useValue: mockChargesService }],
    }).compile();

    controller = module.get<OnboardingChargesController>(
      OnboardingChargesController,
    );
  });

  describe("createOnboardingCharge", () => {
    const dto = {
      customerId: "cust-uuid-1",
      amountCents: 15000,
      description: "Onboarding implementation fee",
      scheduledDate: "2026-03-01",
    };

    it("should return 201 with draft invoice on success", async () => {
      const result = await controller.createOnboardingCharge(dto, "corr-1");

      expect(result).toEqual(mockResponse);
      expect(mockChargesService.createOnboardingCharge).toHaveBeenCalledWith(
        dto,
        "corr-1",
      );
    });

    it("should use default correlation ID when header not provided", async () => {
      await controller.createOnboardingCharge(dto, undefined);

      expect(mockChargesService.createOnboardingCharge).toHaveBeenCalledWith(
        dto,
        "no-correlation-id",
      );
    });

    it("should pass through service exceptions", async () => {
      mockChargesService.createOnboardingCharge.mockRejectedValue(
        new BillingException("Customer not found", HttpStatus.NOT_FOUND),
      );

      await expect(
        controller.createOnboardingCharge(dto, "corr-1"),
      ).rejects.toThrow(BillingException);
    });
  });
});
