export interface CustomerResult {
  id: string;
  email: string;
  name: string | null;
  metadata: Record<string, string>;
  createdAt: Date;
  defaultPaymentMethodId: string | null;
}

export interface PaymentMethodResult {
  id: string;
  customerId: string;
  type: string;
  last4: string | null;
  brand: string | null;
  bankName: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  isDefault: boolean;
}

export interface ChargeResult {
  id: string;
  amount: number;
  currency: string;
  status: "succeeded" | "pending" | "failed";
  customerId: string;
  paymentMethodId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  metadata: Record<string, string>;
  createdAt: Date;
}

export interface RefundResult {
  id: string;
  chargeId: string;
  amount: number;
  currency: string;
  status: "succeeded" | "pending" | "failed";
  reason: string | null;
  createdAt: Date;
}

export interface BalanceTransactionResult {
  id: string;
  amount: number;
  currency: string;
  type: string;
  fee: number;
  net: number;
  source: string | null;
  description: string | null;
  createdAt: Date;
}

export interface CreateCustomerInput {
  email: string;
  name?: string;
  metadata?: Record<string, string>;
}

export interface UpdateCustomerInput {
  email?: string;
  name?: string;
  metadata?: Record<string, string>;
}

export interface CreateChargeInput {
  amount: number;
  currency: string;
  customerId: string;
  paymentMethodId: string;
  description?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface CreateRefundInput {
  chargeId: string;
  amount?: number;
  reason?: string;
  idempotencyKey?: string;
}

export interface GetBalanceTransactionsInput {
  limit?: number;
  startingAfter?: string;
  createdGte?: number;
  createdLte?: number;
  createdLt?: number;
}

// --- Setup Intent types (payment-processor agnostic) ---

export interface SetupIntentResult {
  id: string;
  clientSecret: string;
  status: string;
  paymentMethodId: string | null;
  mandateId: string | null;
}

export interface CreateBankAccountSetupInput {
  customerId: string;
  accountHolderName?: string;
  billingEmail?: string;
  routingNumber: string;
  accountNumber: string;
  accountHolderType: "individual" | "company";
  accountType: "checking" | "savings";
}

export interface CreateFinancialConnectionsSetupInput {
  customerId: string;
}

export interface CreateCardSetupInput {
  customerId: string;
}

export interface ConfirmSetupInput {
  setupIntentId: string;
}

export interface VerifyMicrodepositsInput {
  setupIntentId: string;
  amounts: [number, number];
}
