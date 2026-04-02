export interface SqsEnvelope<T = unknown> {
  version: "1.0";
  type: string;
  timestamp: string;
  correlationId: string;
  payload: T;
  metadata?: Record<string, unknown>;
}
