import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException, HttpStatus } from "@nestjs/common";
import { RefundsController } from "./refunds.controller";
import { RefundsService } from "./refunds.service";
import { BillingException } from "../common/exceptions/billing.exception";
import type { CreateRefundDto } from "./dto/create-refund.dto";

describe("RefundsController", () => {
  let controller: RefundsController;
  let service: { createRefund: jest.Mock; findById: jest.Mock };

  beforeEach(async () => {
    service = {
      createRefund: jest.fn(),
      findById: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RefundsController],
      providers: [{ provide: RefundsService, useValue: service }],
    }).compile();

    controller = module.get<RefundsController>(RefundsController);
  });

  describe("createRefund", () => {
    const dto: CreateRefundDto = {
      chargeId: "c0000000-0000-4000-a000-000000000001",
      amountCents: 5000,
      reason: "customer_request",
    } as CreateRefundDto;

    const refundResponse = {
      id: "r0000000-0000-4000-a000-000000000001",
      chargeId: dto.chargeId,
      invoiceId: "i0000000-0000-4000-a000-000000000001",
      customerId: "u0000000-0000-4000-a000-000000000001",
      amountCents: 5000,
      currency: "usd",
      status: "succeeded",
      reason: "customer_request",
      idempotencyKey: "idem-key-1",
      gatewayRefundId: "re_test_123",
      failureReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    it("should call service.createRefund and return 201 with result", async () => {
      service.createRefund.mockResolvedValue(refundResponse);

      const result = await controller.createRefund(dto, "idem-key-1", "corr-1");

      expect(result).toEqual(refundResponse);
      expect(service.createRefund).toHaveBeenCalledWith(
        dto,
        "idem-key-1",
        "corr-1",
      );
    });

    it("should pass 'no-correlation-id' when correlation ID header is missing", async () => {
      service.createRefund.mockResolvedValue(refundResponse);

      await controller.createRefund(dto, "idem-key-2", undefined);

      expect(service.createRefund).toHaveBeenCalledWith(
        dto,
        "idem-key-2",
        "no-correlation-id",
      );
    });

    it("should throw BillingException with 400 when x-idempotency-key is missing", async () => {
      await expect(
        controller.createRefund(dto, undefined, "corr-1"),
      ).rejects.toThrow(BillingException);

      try {
        await controller.createRefund(dto, undefined, "corr-1");
      } catch (error) {
        expect(error).toBeInstanceOf(BillingException);
        expect((error as BillingException).getStatus()).toBe(
          HttpStatus.BAD_REQUEST,
        );
      }
    });

    it("should throw BillingException with descriptive message for missing idempotency key", async () => {
      await expect(
        controller.createRefund(dto, undefined, "corr-1"),
      ).rejects.toThrow("x-idempotency-key header is required");
    });

    it("should not call service when idempotency key is missing", async () => {
      try {
        await controller.createRefund(dto, undefined, "corr-1");
      } catch {
        // expected
      }

      expect(service.createRefund).not.toHaveBeenCalled();
    });
  });

  describe("getRefund", () => {
    const refundId = "r0000000-0000-4000-a000-000000000001";

    const refundResponse = {
      id: refundId,
      chargeId: "c0000000-0000-4000-a000-000000000001",
      invoiceId: "i0000000-0000-4000-a000-000000000001",
      customerId: "u0000000-0000-4000-a000-000000000001",
      amountCents: 5000,
      currency: "usd",
      status: "succeeded",
      reason: "customer_request",
      idempotencyKey: "idem-key-1",
      gatewayRefundId: "re_test_123",
      failureReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    it("should return refund when found", async () => {
      service.findById.mockResolvedValue(refundResponse);

      const result = await controller.getRefund(refundId);

      expect(result).toEqual(refundResponse);
      expect(service.findById).toHaveBeenCalledWith(refundId);
    });

    it("should throw NotFoundException when refund not found", async () => {
      service.findById.mockResolvedValue(null);

      await expect(controller.getRefund(refundId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should include refund ID in 404 error message", async () => {
      service.findById.mockResolvedValue(null);

      await expect(controller.getRefund(refundId)).rejects.toThrow(
        `Refund ${refundId} not found`,
      );
    });
  });
});
