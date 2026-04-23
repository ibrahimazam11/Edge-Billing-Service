import type {
  CustomerResult,
  PaymentMethodResult,
  ChargeResult,
  RefundResult,
  BalanceTransactionResult,
  SetupIntentResult,
  CreateCustomerInput,
  UpdateCustomerInput,
  CreateChargeInput,
  CreateRefundInput,
  GetBalanceTransactionsInput,
  CreateBankAccountSetupInput,
  CreateFinancialConnectionsSetupInput,
  CreateCardSetupInput,
  ConfirmSetupInput,
  VerifyMicrodepositsInput,
} from "./gateway.types";
import type { NormalizedWebhookEvent } from "../common/interfaces/normalized-webhook-event.interface";

export const PAYMENT_GATEWAY = Symbol("PAYMENT_GATEWAY");

export interface PaymentGateway {
  createCustomer(input: CreateCustomerInput): Promise<CustomerResult>;
  updateCustomer(
    customerId: string,
    input: UpdateCustomerInput,
  ): Promise<CustomerResult>;

  attachPaymentMethod(
    paymentMethodId: string,
    customerId: string,
  ): Promise<PaymentMethodResult>;
  detachPaymentMethod(paymentMethodId: string): Promise<PaymentMethodResult>;
  setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<CustomerResult>;

  createCharge(input: CreateChargeInput): Promise<ChargeResult>;
  createRefund(input: CreateRefundInput): Promise<RefundResult>;

  getCustomer(stripeCustomerId: string): Promise<CustomerResult>;

  listPaymentMethods(customerId: string): Promise<PaymentMethodResult[]>;

  /**
   * Returns ALL balance transactions matching the filter criteria.
   * The adapter handles pagination internally — callers receive the complete result set.
   * The `startingAfter` parameter is used as the initial pagination cursor if provided.
   */
  getBalanceTransactions(
    input?: GetBalanceTransactionsInput,
  ): Promise<BalanceTransactionResult[]>;

  /**
   * Verifies and normalizes a webhook payload from the gateway.
   * Returns null for unmapped/unsupported event types (silently ignored).
   */
  verifyAndParseWebhook(
    rawPayload: string | Buffer,
    headers: Record<string, string>,
  ): Promise<NormalizedWebhookEvent | null>;
}

/**
 * Extended gateway interface for payment processors that support SetupIntents
 * (pre-authorized payment method setup). Currently implemented by Stripe only.
 */
export interface SetupIntentGateway {
  createBankAccountSetup(
    input: CreateBankAccountSetupInput,
  ): Promise<SetupIntentResult>;

  createFinancialConnectionsSetup(
    input: CreateFinancialConnectionsSetupInput,
  ): Promise<SetupIntentResult>;

  createCardSetup(input: CreateCardSetupInput): Promise<SetupIntentResult>;

  retrieveSetupIntent(input: ConfirmSetupInput): Promise<SetupIntentResult>;

  confirmSetup(input: ConfirmSetupInput): Promise<SetupIntentResult>;

  verifyMicrodeposits(
    input: VerifyMicrodepositsInput,
  ): Promise<SetupIntentResult>;
}
