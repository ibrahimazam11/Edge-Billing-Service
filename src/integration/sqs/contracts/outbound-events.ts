export interface PaymentSucceededPayload {
  invoiceId: string;
  customerId: string;
  monolithCustomerId: string;
  amountCents: number;
  currency: string;
  paymentMethodId: string;
  stripePaymentIntentId: string;
}

export interface PaymentFailedPayload {
  invoiceId: string;
  customerId: string;
  monolithCustomerId: string;
  amountCents: number;
  currency: string;
  failureReason: string;
  attemptNumber: number;
}

export interface InvoiceCreatedPayload {
  invoiceId: string;
  customerId: string;
  monolithCustomerId: string;
  subscriptionId?: string;
  totalAmountCents: number;
  currency: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
}

export interface InvoicePaidPayload {
  invoiceId: string;
  customerId: string;
  monolithCustomerId: string;
  totalAmountCents: number;
  currency: string;
  paidAt: string;
}

export interface DunningEscalatedPayload {
  invoiceId: string;
  customerId: string;
  monolithCustomerId: string;
  totalAttempts: number;
  failureHistory: Array<{
    attemptNumber: number;
    failedAt: string;
    reason: string;
  }>;
  amountCents: number;
  currency: string;
}

export interface SubscriptionStateChangedPayload {
  subscriptionId: string;
  customerId: string;
  oldState: string;
  newState: string;
  changedAt: string;
}

export interface RefundSucceededPayload {
  refundId: string;
  chargeId: string;
  invoiceId: string;
  customerId: string;
  amount: number;
  currency: string;
  reason: string | null;
  gatewayProvider: string;
}

export interface RefundFailedPayload {
  refundId: string;
  chargeId: string;
  invoiceId: string;
  customerId: string;
  amount: number;
  currency: string;
  reason: string | null;
  gatewayProvider: string;
  failureReason: string;
}

export interface OutboundEventMap {
  "payment.succeeded": PaymentSucceededPayload;
  "payment.failed": PaymentFailedPayload;
  "invoice.created": InvoiceCreatedPayload;
  "invoice.paid": InvoicePaidPayload;
  "dunning.escalated": DunningEscalatedPayload;
  "subscription.state.changed": SubscriptionStateChangedPayload;
  "refund.succeeded": RefundSucceededPayload;
  "refund.failed": RefundFailedPayload;
}

export type OutboundEventType = keyof OutboundEventMap;
