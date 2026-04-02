import { BusinessRuleViolationException } from "../common/exceptions/billing.exception";
import { validateRefundAmount } from "./validate-refund-amount";

describe("validateRefundAmount", () => {
  describe("valid refund amounts", () => {
    it("should allow a full refund with no existing refunds", () => {
      expect(() => validateRefundAmount(10000, 0, 10000)).not.toThrow();
    });

    it("should allow a partial refund with no existing refunds", () => {
      expect(() => validateRefundAmount(10000, 0, 5000)).not.toThrow();
    });

    it("should allow a partial refund when existing refunds leave room", () => {
      expect(() => validateRefundAmount(10000, 3000, 5000)).not.toThrow();
    });

    it("should allow a refund that reaches exactly the charge amount", () => {
      expect(() => validateRefundAmount(10000, 7000, 3000)).not.toThrow();
    });

    it("should allow a zero-amount refund", () => {
      expect(() => validateRefundAmount(10000, 5000, 0)).not.toThrow();
    });
  });

  describe("invalid refund amounts", () => {
    it("should reject when total refunds would exceed charge amount (AC #5)", () => {
      expect(() => validateRefundAmount(10000, 7000, 5000)).toThrow(
        BusinessRuleViolationException,
      );
    });

    it("should reject when refund alone exceeds charge amount", () => {
      expect(() => validateRefundAmount(10000, 0, 15000)).toThrow(
        BusinessRuleViolationException,
      );
    });

    it("should reject by exactly one cent over limit", () => {
      expect(() => validateRefundAmount(10000, 7000, 3001)).toThrow(
        BusinessRuleViolationException,
      );
    });

    it("should return 422 Unprocessable Entity status", () => {
      try {
        validateRefundAmount(10000, 7000, 5000);
        fail("Expected BusinessRuleViolationException to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessRuleViolationException);
        expect((error as BusinessRuleViolationException).getStatus()).toBe(422);
      }
    });

    it("should include all amounts in error details", () => {
      try {
        validateRefundAmount(10000, 7000, 5000);
        fail("Expected BusinessRuleViolationException to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessRuleViolationException);
        const response = (
          error as BusinessRuleViolationException
        ).getResponse() as {
          details: {
            chargeAmountCents: number;
            existingRefundsTotalCents: number;
            requestedAmountCents: number;
            totalAfterRefund: number;
          };
        };
        expect(response.details).toEqual({
          chargeAmountCents: 10000,
          existingRefundsTotalCents: 7000,
          requestedAmountCents: 5000,
          totalAfterRefund: 12000,
        });
      }
    });

    it("should include descriptive error message", () => {
      try {
        validateRefundAmount(10000, 7000, 5000);
        fail("Expected BusinessRuleViolationException to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessRuleViolationException);
        const response = (
          error as BusinessRuleViolationException
        ).getResponse() as { message: string };
        expect(response.message).toBe(
          "Total refunds (12000) would exceed charge amount (10000)",
        );
      }
    });
  });
});
