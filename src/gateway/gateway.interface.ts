import type {
  CustomerResult,
  PaymentMethodResult,
  ChargeResult,
  RefundResult,
  BalanceTransactionResult,
  CreateCustomerInput,
  UpdateCustomerInput,
  CreateChargeInput,
  CreateRefundInput,
  GetBalanceTransactionsInput,
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
