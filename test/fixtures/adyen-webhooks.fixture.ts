import { hmacValidator as HmacValidator, Types } from "@adyen/api-library";

interface AdyenNotificationItem {
  pspReference: string;
  originalReference: string;
  merchantAccountCode: string;
  merchantReference: string;
  amount: { currency: string; value: number };
  eventCode: string;
  success: string;
  additionalData: Record<string, string>;
}

/**
 * Build a signed Adyen AUTHORISATION webhook payload.
 */
export function buildAdyenAuthorisationPayload(
  pspReference: string,
  merchantReference: string,
  amount: { currency: string; value: number },
  hmacKey: string,
  success = true,
): string {
  const notification: AdyenNotificationItem = {
    pspReference,
    originalReference: "",
    merchantAccountCode: "TestMerchant",
    merchantReference,
    amount,
    eventCode: "AUTHORISATION",
    success: success ? "true" : "false",
    additionalData: { hmacSignature: "" },
  };

  const validator = new HmacValidator();
  const hmac = validator.calculateHmac(
    notification as unknown as Types.notification.NotificationRequestItem,
    hmacKey,
  );
  notification.additionalData.hmacSignature = hmac;

  return JSON.stringify({
    notificationItems: [{ NotificationRequestItem: notification }],
  });
}

/**
 * Build a signed Adyen REFUND webhook payload.
 */
export function buildAdyenRefundPayload(
  pspReference: string,
  originalReference: string,
  amount: { currency: string; value: number },
  hmacKey: string,
): string {
  const notification: AdyenNotificationItem = {
    pspReference,
    originalReference,
    merchantAccountCode: "TestMerchant",
    merchantReference: "",
    amount,
    eventCode: "REFUND",
    success: "true",
    additionalData: { hmacSignature: "" },
  };

  const validator = new HmacValidator();
  const hmac = validator.calculateHmac(
    notification as unknown as Types.notification.NotificationRequestItem,
    hmacKey,
  );
  notification.additionalData.hmacSignature = hmac;

  return JSON.stringify({
    notificationItems: [{ NotificationRequestItem: notification }],
  });
}
