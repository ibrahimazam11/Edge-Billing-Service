import { validateTransition } from "../common/utils/state-machine.util";
import { StateTransitionException } from "../common/exceptions/billing.exception";
import { REFUND_TRANSITIONS, type RefundStatus } from "./refund-state-machine";

describe("Refund State Machine", () => {
  describe("valid transitions", () => {
    const validTransitions: [RefundStatus, RefundStatus][] = [
      ["pending", "processing"],
      ["processing", "succeeded"],
      ["processing", "failed"],
    ];

    it.each(validTransitions)(
      "should allow transition from %s to %s",
      (from, to) => {
        expect(() =>
          validateTransition(from, to, REFUND_TRANSITIONS),
        ).not.toThrow();
      },
    );
  });

  describe("invalid transitions", () => {
    const invalidTransitions: [RefundStatus, RefundStatus][] = [
      ["pending", "succeeded"],
      ["pending", "failed"],
      ["processing", "pending"],
      ["succeeded", "pending"],
      ["succeeded", "processing"],
      ["succeeded", "failed"],
      ["failed", "pending"],
      ["failed", "processing"],
      ["failed", "succeeded"],
    ];

    it.each(invalidTransitions)(
      "should reject transition from %s to %s",
      (from, to) => {
        expect(() => validateTransition(from, to, REFUND_TRANSITIONS)).toThrow(
          StateTransitionException,
        );
      },
    );
  });

  describe("terminal state enforcement", () => {
    it("should have no outbound transitions from succeeded", () => {
      expect(REFUND_TRANSITIONS.succeeded).toEqual([]);
    });

    it("should have no outbound transitions from failed", () => {
      expect(REFUND_TRANSITIONS.failed).toEqual([]);
    });
  });

  describe("transition details", () => {
    it("should include currentState, targetState, and allowedTransitions in error", () => {
      try {
        validateTransition("succeeded", "processing", REFUND_TRANSITIONS);
        fail("Expected StateTransitionException to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(StateTransitionException);
        const response = (error as StateTransitionException).getResponse() as {
          details: {
            currentState: string;
            targetState: string;
            allowedTransitions: string[];
          };
        };
        expect(response.details.currentState).toBe("succeeded");
        expect(response.details.targetState).toBe("processing");
        expect(response.details.allowedTransitions).toEqual([]);
      }
    });

    it("should return 409 Conflict status", () => {
      try {
        validateTransition("succeeded", "processing", REFUND_TRANSITIONS);
        fail("Expected StateTransitionException to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(StateTransitionException);
        expect((error as StateTransitionException).getStatus()).toBe(409);
      }
    });
  });
});
