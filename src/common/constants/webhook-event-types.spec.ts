import {
  WEBHOOK_PAYMENT_SUCCEEDED,
  WEBHOOK_PAYMENT_FAILED,
  WEBHOOK_REFUND_COMPLETED,
  WEBHOOK_REFUND_FAILED,
  WEBHOOK_CHARGEBACK_CREATED,
} from "./webhook-event-types";

describe("WebhookEventTypes constants", () => {
  it("WEBHOOK_PAYMENT_SUCCEEDED equals 'payment.succeeded'", () => {
    expect(WEBHOOK_PAYMENT_SUCCEEDED).toBe("payment.succeeded");
  });

  it("WEBHOOK_PAYMENT_FAILED equals 'payment.failed'", () => {
    expect(WEBHOOK_PAYMENT_FAILED).toBe("payment.failed");
  });

  it("WEBHOOK_REFUND_COMPLETED equals 'refund.completed'", () => {
    expect(WEBHOOK_REFUND_COMPLETED).toBe("refund.completed");
  });

  it("WEBHOOK_REFUND_FAILED equals 'refund.failed'", () => {
    expect(WEBHOOK_REFUND_FAILED).toBe("refund.failed");
  });

  it("WEBHOOK_CHARGEBACK_CREATED equals 'chargeback.created'", () => {
    expect(WEBHOOK_CHARGEBACK_CREATED).toBe("chargeback.created");
  });

  it("constants are distinct values", () => {
    const values = new Set([
      WEBHOOK_PAYMENT_SUCCEEDED,
      WEBHOOK_PAYMENT_FAILED,
      WEBHOOK_REFUND_COMPLETED,
      WEBHOOK_REFUND_FAILED,
      WEBHOOK_CHARGEBACK_CREATED,
    ]);
    expect(values.size).toBe(5);
  });

  it("constants follow dot-separated lowercase naming", () => {
    const allConstants = [
      WEBHOOK_PAYMENT_SUCCEEDED,
      WEBHOOK_PAYMENT_FAILED,
      WEBHOOK_REFUND_COMPLETED,
      WEBHOOK_REFUND_FAILED,
      WEBHOOK_CHARGEBACK_CREATED,
    ];
    for (const c of allConstants) {
      expect(c).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });
});
