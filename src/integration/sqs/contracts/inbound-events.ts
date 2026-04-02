export interface CustomerCreatedPayload {
  monolithCustomerId: string;
  name: string;
  email: string;
  metadata?: Record<string, unknown>;
}

export interface CustomerUpdatedPayload {
  monolithCustomerId: string;
  name?: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

export interface PayrollCalculatedPayload {
  monolithCustomerId: string;
  amountCents: number;
  currency: string;
  calculationDate: string;
}

export interface StripeWebhookReceivedPayload {
  stripeEventId: string;
  type: string;
  data: Record<string, unknown>;
  signature: string;
}

export interface AdyenWebhookReceivedPayload {
  adyenEventId: string;
  rawPayload: string;
  headers: Record<string, string>;
}

export interface BillingScheduleGenerateInvoicesPayload {
  scheduledDate: string;
}

export interface BillingScheduleProcessDunningPayload {
  scheduledDate: string;
}

export interface BillingScheduleDailyReconciliationPayload {
  scheduledDate: string;
  periodStart?: string;
  periodEnd?: string;
}

export interface InboundEventMap {
  "customer.created": CustomerCreatedPayload;
  "customer.updated": CustomerUpdatedPayload;
  "payroll.calculated": PayrollCalculatedPayload;
  "stripe.webhook.received": StripeWebhookReceivedPayload;
  "adyen.webhook.received": AdyenWebhookReceivedPayload;
  "billing.schedule.generate-invoices": BillingScheduleGenerateInvoicesPayload;
  "billing.schedule.process-dunning": BillingScheduleProcessDunningPayload;
  "billing.schedule.daily-reconciliation": BillingScheduleDailyReconciliationPayload;
}

export type InboundEventType = keyof InboundEventMap;
