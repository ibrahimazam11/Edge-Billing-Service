import {
  BillingException,
  BusinessRuleViolationException,
  StateTransitionException,
} from "./billing.exception";
import { HttpStatus } from "@nestjs/common";

describe("BillingException", () => {
  it("should create exception with default status 500", () => {
    const exception = new BillingException("Something failed");
    expect(exception.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(exception.getResponse()).toEqual(
      expect.objectContaining({
        statusCode: 500,
        message: "Something failed",
      }),
    );
  });

  it("should create exception with custom status and details", () => {
    const exception = new BillingException(
      "Custom error",
      HttpStatus.BAD_REQUEST,
      { field: "email" },
    );
    expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(exception.getResponse()).toEqual(
      expect.objectContaining({
        statusCode: 400,
        message: "Custom error",
        details: { field: "email" },
      }),
    );
  });
});

describe("BusinessRuleViolationException", () => {
  it("should return 422 status", () => {
    const exception = new BusinessRuleViolationException("Rule violated");
    expect(exception.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });
});

describe("StateTransitionException", () => {
  it("should return 409 status", () => {
    const exception = new StateTransitionException("Invalid transition");
    expect(exception.getStatus()).toBe(HttpStatus.CONFLICT);
  });
});
