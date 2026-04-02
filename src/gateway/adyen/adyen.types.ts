import type { NormalizedWebhookEventType } from "../../common/interfaces/normalized-webhook-event.interface";
import {
  PAYMENT_METHOD_TYPE_CARD,
  PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
  PAYMENT_METHOD_TYPE_BANK_TRANSFER,
} from "../../common/constants/payment-method-types";
import {
  WEBHOOK_PAYMENT_SUCCEEDED,
  WEBHOOK_REFUND_COMPLETED,
  WEBHOOK_REFUND_FAILED,
  WEBHOOK_CHARGEBACK_CREATED,
} from "../../common/constants/webhook-event-types";

/**
 * Maps Adyen payment method types to internal normalized types.
 * Unknown types pass through as-is.
 */
export const ADYEN_PM_TYPE_MAP: Record<string, string> = {
  scheme: PAYMENT_METHOD_TYPE_CARD,
  mc: PAYMENT_METHOD_TYPE_CARD,
  visa: PAYMENT_METHOD_TYPE_CARD,
  amex: PAYMENT_METHOD_TYPE_CARD,
  sepadirectdebit: PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
  ach: PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
  ideal: PAYMENT_METHOD_TYPE_BANK_TRANSFER,
};

/**
 * Maps Adyen webhook eventCodes to internal normalized event types.
 * AUTHORISATION is handled separately due to success/failure branching.
 */
export const ADYEN_EVENT_MAP: Record<string, NormalizedWebhookEventType> = {
  AUTHORISATION: WEBHOOK_PAYMENT_SUCCEEDED,
  REFUND: WEBHOOK_REFUND_COMPLETED,
  REFUND_FAILED: WEBHOOK_REFUND_FAILED,
  CHARGEBACK: WEBHOOK_CHARGEBACK_CREATED,
};

/**
 * Maps Adyen resultCode to internal charge status.
 */
export function mapAdyenResultCode(
  resultCode: string,
): "succeeded" | "pending" | "failed" {
  switch (resultCode) {
    case "Authorised":
      return "succeeded";
    case "Refused":
    case "Error":
      return "failed";
    case "Pending":
    case "Received":
      return "pending";
    default:
      return "pending";
  }
}

/**
 * Normalizes an Adyen PM type to internal type.
 * Returns the original value if no mapping exists.
 */
export function normalizeAdyenPmType(adyenType: string): string {
  return ADYEN_PM_TYPE_MAP[adyenType] ?? adyenType;
}
