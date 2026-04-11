export interface CustomerCreatedPayload {
  monolithCustomerId: string;
  name: string;
  email: string;
  chargeDay?: number;
  isPrepaid?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CustomerUpdatedPayload {
  monolithCustomerId: string;
  name?: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

export interface PayrollEmployeeLineItem {
  employeeId: string;
  employeeName: string;
  customerCost: number;
  salary: number;
  platformFee: number;
  bonus: number;
  raise: number;
  discount: number;
}

export interface PayrollCalculatedPayload {
  monolithCustomerId: string;
  payrollMonth: string;
  currency: string;
  totalAmountCents: number;
  employees: PayrollEmployeeLineItem[];
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

export interface InvoiceLineItemPayload {
  description: string;
  amountCents: number;
}

export type InvoiceType = "onboarding" | "one_time";

export interface InvoiceCreatePayload {
  monolithCustomerId: string;
  type: InvoiceType;
  currency: string;
  totalAmountCents: number;
  lineItems: InvoiceLineItemPayload[];
  dueDate: string;
  metadata?: Record<string, unknown>;
}

export interface SubscriptionCreatePayload {
  monolithCustomerId: string;
  planName: string;
  amountCents: number;
  currency: string;
  billingInterval: string;
  billingStartDate: string;
  onboardingDate: string;
  /** Employee line items for first monthly invoice — avoids race with payroll.calculated */
  employees?: PayrollEmployeeLineItem[];
}

export interface SurchargeConfigUpdatedPayload {
  monolithCustomerId: string;
  allowCreditCard: boolean;
  surchargeType: "percentage" | "flat_fee" | null;
  surchargeValue: number | null;
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
  "invoice.create": InvoiceCreatePayload;
  "payroll.calculated": PayrollCalculatedPayload;
  "subscription.create": SubscriptionCreatePayload;
  "surcharge-config.updated": SurchargeConfigUpdatedPayload;
  "stripe.webhook.received": StripeWebhookReceivedPayload;
  "adyen.webhook.received": AdyenWebhookReceivedPayload;
  "billing.schedule.generate-invoices": BillingScheduleGenerateInvoicesPayload;
  "billing.schedule.process-dunning": BillingScheduleProcessDunningPayload;
  "billing.schedule.daily-reconciliation": BillingScheduleDailyReconciliationPayload;
}

export type InboundEventType = keyof InboundEventMap;
