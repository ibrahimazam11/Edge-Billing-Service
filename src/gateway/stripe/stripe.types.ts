import Stripe from "stripe";
import type {
  CustomerResult,
  PaymentMethodResult,
  ChargeResult,
  RefundResult,
  BalanceTransactionResult,
} from "../gateway.types";
import {
  PAYMENT_METHOD_TYPE_CARD,
  PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
} from "../../common/constants/payment-method-types";

export function mapStripeCustomer(customer: Stripe.Customer): CustomerResult {
  const defaultPm = customer.invoice_settings?.default_payment_method;
  return {
    id: customer.id,
    email: customer.email ?? "",
    name: customer.name ?? null,
    metadata: (customer.metadata as Record<string, string>) ?? {},
    createdAt: new Date(customer.created * 1000),
    defaultPaymentMethodId:
      typeof defaultPm === "string" ? defaultPm : (defaultPm?.id ?? null),
  };
}

export function mapStripePaymentMethod(
  pm: Stripe.PaymentMethod,
  isDefault: boolean = false,
): PaymentMethodResult {
  return {
    id: pm.id,
    customerId:
      typeof pm.customer === "string" ? pm.customer : (pm.customer?.id ?? ""),
    type:
      pm.type === "card"
        ? PAYMENT_METHOD_TYPE_CARD
        : PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
    last4: pm.card?.last4 ?? pm.us_bank_account?.last4 ?? null,
    brand: pm.card?.brand ?? null,
    bankName: pm.us_bank_account?.bank_name ?? null,
    expiryMonth: pm.card?.exp_month ?? null,
    expiryYear: pm.card?.exp_year ?? null,
    isDefault,
    fingerprint: pm.us_bank_account?.fingerprint ?? pm.card?.fingerprint ?? null,
  };
}

/**
 * Maps a legacy Stripe customer source — `Stripe.BankAccount` (id prefix `ba_`),
 * `Stripe.Card` (id prefix `card_`), or `Stripe.Source` (id prefix `src_`) — into the
 * same `PaymentMethodResult` shape that `mapStripePaymentMethod` returns.
 *
 * Existing customers have these legacy IDs on Stripe and they are NOT returned by
 * `stripe.paymentMethods.list({customer})`. They are only visible via
 * `stripe.customers.listSources({customer})`. All three id prefixes work as
 * `payment_method` on `invoices.pay()` per project decision; this mapper exists so the
 * read path (listPaymentMethods) sees them too.
 */
export function mapStripeSource(
  source: Stripe.BankAccount | Stripe.Card | Stripe.Source,
  isDefault: boolean = false,
): PaymentMethodResult {
  const customerId =
    typeof source.customer === "string"
      ? source.customer
      : (source.customer?.id ?? "");

  if (source.object === "bank_account") {
    const ba = source;
    return {
      id: ba.id,
      customerId,
      type: PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
      last4: ba.last4 ?? null,
      brand: null,
      bankName: ba.bank_name ?? null,
      expiryMonth: null,
      expiryYear: null,
      isDefault,
      fingerprint: ba.fingerprint ?? null,
    };
  }
  if (source.object === "card") {
    const card = source;
    return {
      id: card.id,
      customerId,
      type: PAYMENT_METHOD_TYPE_CARD,
      last4: card.last4 ?? null,
      brand: card.brand ?? null,
      bankName: null,
      expiryMonth: card.exp_month ?? null,
      expiryYear: card.exp_year ?? null,
      isDefault,
      fingerprint: card.fingerprint ?? null,
    };
  }
  // Stripe.Source (legacy Sources API). Type may be 'card', 'ach_credit_transfer', etc.
  const src = source;
  const isCard = src.type === "card";
  return {
    id: src.id,
    customerId,
    type: isCard ? PAYMENT_METHOD_TYPE_CARD : PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
    last4: src.card?.last4 ?? null,
    brand: src.card?.brand ?? null,
    bankName: null,
    expiryMonth: src.card?.exp_month ?? null,
    expiryYear: src.card?.exp_year ?? null,
    isDefault,
    fingerprint: null,
  };
}

export function mapStripePaymentIntent(pi: Stripe.PaymentIntent): ChargeResult {
  return {
    id: pi.id,
    amount: pi.amount,
    currency: pi.currency,
    status: mapPaymentIntentStatus(pi.status),
    customerId:
      typeof pi.customer === "string" ? pi.customer : (pi.customer?.id ?? ""),
    paymentMethodId:
      typeof pi.payment_method === "string"
        ? pi.payment_method
        : (pi.payment_method?.id ?? null),
    failureCode: pi.last_payment_error?.code ?? null,
    failureMessage: pi.last_payment_error?.message ?? null,
    metadata: (pi.metadata as Record<string, string>) ?? {},
    createdAt: new Date(pi.created * 1000),
  };
}

function mapPaymentIntentStatus(
  status: Stripe.PaymentIntent.Status,
): "succeeded" | "pending" | "failed" {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "canceled":
      return "failed";
    case "requires_payment_method":
      return "failed";
    default:
      return "pending";
  }
}

export function mapStripeRefund(refund: Stripe.Refund): RefundResult {
  return {
    id: refund.id,
    chargeId:
      typeof refund.charge === "string"
        ? refund.charge
        : (refund.charge?.id ?? ""),
    amount: refund.amount ?? 0,
    currency: refund.currency,
    status: mapRefundStatus(refund.status),
    reason: refund.reason ?? null,
    createdAt: new Date(refund.created * 1000),
  };
}

function mapRefundStatus(
  status: string | null,
): "succeeded" | "pending" | "failed" {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "failed";
    default:
      return "pending";
  }
}

export function mapStripeBalanceTransaction(
  bt: Stripe.BalanceTransaction,
): BalanceTransactionResult {
  return {
    id: bt.id,
    amount: bt.amount,
    currency: bt.currency,
    type: bt.type,
    fee: bt.fee,
    net: bt.net,
    source: typeof bt.source === "string" ? bt.source : (bt.source?.id ?? null),
    description: bt.description ?? null,
    createdAt: new Date(bt.created * 1000),
  };
}
