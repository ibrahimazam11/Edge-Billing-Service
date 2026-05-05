import { redactPii } from "./instrument";

describe("redactPii", () => {
  it.each([
    "email",
    "phone",
    "firstName",
    "lastName",
    "dateOfBirth",
    "taxId",
    "ssn",
    "cardNumber",
    "cvv",
    "iban",
    "bankAccount",
    "accountNumber",
    "routingNumber",
    "paymentMethodId",
    "stripeSecretKey",
    "adyenApiKey",
    "webhookSecret",
  ])("redacts %s at the top level", (key) => {
    const out = redactPii({ [key]: "sensitive" });
    expect(out).toEqual({ [key]: "[REDACTED]" });
  });

  it("redacts case-insensitively", () => {
    const out = redactPii({ EMAIL: "x@y.com", PaymentMethodId: "pm_123" });
    expect(out).toEqual({
      EMAIL: "[REDACTED]",
      PaymentMethodId: "[REDACTED]",
    });
  });

  it("preserves keys that aren't on the redaction list", () => {
    const out = redactPii({ customerId: "c-1", invoiceId: "i-1" });
    expect(out).toEqual({ customerId: "c-1", invoiceId: "i-1" });
  });

  it("does NOT redact monetary fields", () => {
    const out = redactPii({
      amountCents: 1234,
      totalAmountCents: 5678,
      surchargeCents: 90,
    });
    expect(out).toEqual({
      amountCents: 1234,
      totalAmountCents: 5678,
      surchargeCents: 90,
    });
  });

  it("redacts nested PII inside arbitrary objects and arrays", () => {
    const out = redactPii({
      customer: { id: "c-1", email: "x@y.com" },
      payments: [{ paymentMethodId: "pm_1" }, { paymentMethodId: "pm_2" }],
    });
    expect(out).toEqual({
      customer: { id: "c-1", email: "[REDACTED]" },
      payments: [
        { paymentMethodId: "[REDACTED]" },
        { paymentMethodId: "[REDACTED]" },
      ],
    });
  });

  it("returns primitives unchanged", () => {
    expect(redactPii("hello")).toBe("hello");
    expect(redactPii(42)).toBe(42);
    expect(redactPii(null)).toBeNull();
    expect(redactPii(undefined)).toBeUndefined();
  });

  it("does not infinite-loop on deep / cyclic-shaped trees", () => {
    let nested: Record<string, unknown> = { email: "leaf@x.com" };
    for (let i = 0; i < 30; i++) nested = { inner: nested };
    expect(() => redactPii(nested)).not.toThrow();
  });

  it("redacts snake_case and kebab-case PII variants", () => {
    const out = redactPii({
      account_number: "1234",
      "routing-number": "5678",
      payment_method_id: "pm_x",
      first_name: "Alice",
      tax_id: "T-1",
    });
    expect(out).toEqual({
      account_number: "[REDACTED]",
      "routing-number": "[REDACTED]",
      payment_method_id: "[REDACTED]",
      first_name: "[REDACTED]",
      tax_id: "[REDACTED]",
    });
  });

  it("redacts PII keys on class instances, not just plain objects", () => {
    class Customer {
      constructor(
        public id: string,
        public email: string,
      ) {}
    }
    const out = redactPii(new Customer("c-1", "x@y.com")) as unknown as Record<
      string,
      unknown
    >;
    expect(out.id).toBe("c-1");
    expect(out.email).toBe("[REDACTED]");
  });

  it("returns Date / RegExp / Buffer / Map / Set as-is (no walk, no data loss)", () => {
    const d = new Date("2026-01-01");
    const r = /abc/g;
    const b = Buffer.from("hi");
    const m = new Map([["k", "v"]]);
    const s = new Set([1, 2]);
    expect(redactPii({ d }).d).toBe(d);
    expect(redactPii({ r }).r).toBe(r);
    expect(redactPii({ b }).b).toBe(b);
    expect(redactPii({ m }).m).toBe(m);
    expect(redactPii({ s }).s).toBe(s);
  });

  it("does not throw and does not drop neighboring keys when a getter throws", () => {
    const obj: Record<string, unknown> = { id: "c-1" };
    Object.defineProperty(obj, "danger", {
      enumerable: true,
      get() {
        throw new Error("getter blew up");
      },
    });
    obj.email = "x@y.com";
    const out = redactPii(obj);
    expect(out.id).toBe("c-1");
    expect(out.email).toBe("[REDACTED]");
    expect(out.danger).toBe("[REDACTED]");
  });
});
