import {
  PAYMENT_METHOD_TYPE_CARD,
  PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
  PAYMENT_METHOD_TYPE_BANK_TRANSFER,
} from "./payment-method-types";

describe("PaymentMethodTypes constants", () => {
  it("PAYMENT_METHOD_TYPE_CARD equals 'card'", () => {
    expect(PAYMENT_METHOD_TYPE_CARD).toBe("card");
  });

  it("PAYMENT_METHOD_TYPE_BANK_ACCOUNT equals 'bank_account'", () => {
    expect(PAYMENT_METHOD_TYPE_BANK_ACCOUNT).toBe("bank_account");
  });

  it("PAYMENT_METHOD_TYPE_BANK_TRANSFER equals 'bank_transfer'", () => {
    expect(PAYMENT_METHOD_TYPE_BANK_TRANSFER).toBe("bank_transfer");
  });

  it("constants are distinct values", () => {
    const values = new Set([
      PAYMENT_METHOD_TYPE_CARD,
      PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
      PAYMENT_METHOD_TYPE_BANK_TRANSFER,
    ]);
    expect(values.size).toBe(3);
  });
});
