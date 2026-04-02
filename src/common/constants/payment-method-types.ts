export const PAYMENT_METHOD_TYPE_CARD = "card" as const;
export const PAYMENT_METHOD_TYPE_BANK_ACCOUNT = "bank_account" as const;
export const PAYMENT_METHOD_TYPE_BANK_TRANSFER = "bank_transfer" as const;

export type PaymentMethodType =
  | typeof PAYMENT_METHOD_TYPE_CARD
  | typeof PAYMENT_METHOD_TYPE_BANK_ACCOUNT
  | typeof PAYMENT_METHOD_TYPE_BANK_TRANSFER;
