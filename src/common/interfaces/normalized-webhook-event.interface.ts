import type { GatewayProvider } from "../enums/gateway-provider.enum";

export type NormalizedWebhookEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "refund.completed"
  | "refund.failed"
  | "chargeback.created";

export interface NormalizedWebhookEvent {
  eventType: NormalizedWebhookEventType;
  gatewayProvider: GatewayProvider;
  gatewayEventId: string;
  gatewayChargeId: string;
  amount: number;
  currency: string;
  status: string;
  metadata: Record<string, unknown>;
  receivedAt: Date;
}
