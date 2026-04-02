import { validateTransition } from "../common/utils/state-machine.util";
import { StateTransitionException } from "../common/exceptions/billing.exception";
import {
  SUBSCRIPTION_TRANSITIONS,
  type SubscriptionStatus,
} from "./subscription-state-machine";

describe("Subscription State Machine", () => {
  describe("valid transitions", () => {
    const validTransitions: [SubscriptionStatus, SubscriptionStatus][] = [
      ["pending", "active"],
      ["active", "paused"],
      ["active", "canceled"],
      ["active", "past_due"],
      ["paused", "active"],
      ["paused", "canceled"],
      ["past_due", "active"],
      ["past_due", "canceled"],
    ];

    it.each(validTransitions)(
      "should allow transition from %s to %s",
      (from, to) => {
        expect(() =>
          validateTransition(from, to, SUBSCRIPTION_TRANSITIONS),
        ).not.toThrow();
      },
    );
  });

  describe("invalid transitions", () => {
    const invalidTransitions: [SubscriptionStatus, SubscriptionStatus][] = [
      ["pending", "paused"],
      ["pending", "canceled"],
      ["pending", "past_due"],
      ["active", "pending"],
      ["paused", "pending"],
      ["paused", "past_due"],
      ["past_due", "pending"],
      ["past_due", "paused"],
      ["canceled", "active"],
      ["canceled", "pending"],
      ["canceled", "paused"],
      ["canceled", "past_due"],
    ];

    it.each(invalidTransitions)(
      "should reject transition from %s to %s",
      (from, to) => {
        expect(() =>
          validateTransition(from, to, SUBSCRIPTION_TRANSITIONS),
        ).toThrow(StateTransitionException);
      },
    );
  });

  describe("terminal state enforcement", () => {
    it("should have no outbound transitions from canceled", () => {
      expect(SUBSCRIPTION_TRANSITIONS.canceled).toEqual([]);
    });
  });

  describe("transition details", () => {
    it("should include currentState, targetState, and allowedTransitions in error", () => {
      try {
        validateTransition("canceled", "active", SUBSCRIPTION_TRANSITIONS);
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
        expect(response.details.currentState).toBe("canceled");
        expect(response.details.targetState).toBe("active");
        expect(response.details.allowedTransitions).toEqual([]);
      }
    });
  });
});
