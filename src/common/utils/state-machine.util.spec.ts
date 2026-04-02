import { validateTransition, AllowedTransitions } from "./state-machine.util";
import { StateTransitionException } from "../exceptions/billing.exception";

describe("State Machine Utility", () => {
  type TestState = "pending" | "active" | "paused" | "canceled";

  const transitions: AllowedTransitions<TestState> = {
    pending: ["active"],
    active: ["paused", "canceled"],
    paused: ["active", "canceled"],
    canceled: [],
  };

  it("should allow valid transitions", () => {
    expect(() =>
      validateTransition("pending", "active", transitions),
    ).not.toThrow();
  });

  it("should allow multiple valid target states", () => {
    expect(() =>
      validateTransition("active", "paused", transitions),
    ).not.toThrow();
    expect(() =>
      validateTransition("active", "canceled", transitions),
    ).not.toThrow();
  });

  it("should throw StateTransitionException for invalid transitions", () => {
    expect(() =>
      validateTransition("pending", "canceled", transitions),
    ).toThrow(StateTransitionException);
  });

  it("should throw for transitions from terminal state", () => {
    expect(() => validateTransition("canceled", "active", transitions)).toThrow(
      StateTransitionException,
    );
  });

  it("should include state details in exception", () => {
    try {
      validateTransition("pending", "canceled", transitions);
      fail("Expected StateTransitionException");
    } catch (error) {
      expect(error).toBeInstanceOf(StateTransitionException);
      const response = (error as StateTransitionException).getResponse();
      expect(response).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("'pending'"),
          details: expect.objectContaining({
            currentState: "pending",
            targetState: "canceled",
            allowedTransitions: ["active"],
          }),
        }),
      );
    }
  });
});
