import {
  ADYEN_PM_TYPE_MAP,
  ADYEN_EVENT_MAP,
  mapAdyenResultCode,
  normalizeAdyenPmType,
} from "./adyen.types";
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

describe("Adyen Types", () => {
  describe("ADYEN_PM_TYPE_MAP", () => {
    it("should map scheme to card", () => {
      expect(ADYEN_PM_TYPE_MAP.scheme).toBe(PAYMENT_METHOD_TYPE_CARD);
    });

    it("should map mc to card", () => {
      expect(ADYEN_PM_TYPE_MAP.mc).toBe(PAYMENT_METHOD_TYPE_CARD);
    });

    it("should map visa to card", () => {
      expect(ADYEN_PM_TYPE_MAP.visa).toBe(PAYMENT_METHOD_TYPE_CARD);
    });

    it("should map amex to card", () => {
      expect(ADYEN_PM_TYPE_MAP.amex).toBe(PAYMENT_METHOD_TYPE_CARD);
    });

    it("should map sepadirectdebit to bank_account", () => {
      expect(ADYEN_PM_TYPE_MAP.sepadirectdebit).toBe(
        PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
      );
    });

    it("should map ach to bank_account", () => {
      expect(ADYEN_PM_TYPE_MAP.ach).toBe(PAYMENT_METHOD_TYPE_BANK_ACCOUNT);
    });

    it("should map ideal to bank_transfer", () => {
      expect(ADYEN_PM_TYPE_MAP.ideal).toBe(PAYMENT_METHOD_TYPE_BANK_TRANSFER);
    });
  });

  describe("ADYEN_EVENT_MAP", () => {
    it("should map AUTHORISATION to payment.succeeded", () => {
      expect(ADYEN_EVENT_MAP.AUTHORISATION).toBe(WEBHOOK_PAYMENT_SUCCEEDED);
    });

    it("should map REFUND to refund.completed", () => {
      expect(ADYEN_EVENT_MAP.REFUND).toBe(WEBHOOK_REFUND_COMPLETED);
    });

    it("should map REFUND_FAILED to refund.failed", () => {
      expect(ADYEN_EVENT_MAP.REFUND_FAILED).toBe(WEBHOOK_REFUND_FAILED);
    });

    it("should map CHARGEBACK to chargeback.created", () => {
      expect(ADYEN_EVENT_MAP.CHARGEBACK).toBe(WEBHOOK_CHARGEBACK_CREATED);
    });

    it("should return undefined for unmapped event codes", () => {
      expect(ADYEN_EVENT_MAP["CAPTURE"]).toBeUndefined();
      expect(ADYEN_EVENT_MAP["REPORT_AVAILABLE"]).toBeUndefined();
    });
  });

  describe("mapAdyenResultCode", () => {
    it("should map Authorised to succeeded", () => {
      expect(mapAdyenResultCode("Authorised")).toBe("succeeded");
    });

    it("should map Refused to failed", () => {
      expect(mapAdyenResultCode("Refused")).toBe("failed");
    });

    it("should map Error to failed", () => {
      expect(mapAdyenResultCode("Error")).toBe("failed");
    });

    it("should map Pending to pending", () => {
      expect(mapAdyenResultCode("Pending")).toBe("pending");
    });

    it("should map Received to pending", () => {
      expect(mapAdyenResultCode("Received")).toBe("pending");
    });

    it("should default unknown result codes to pending", () => {
      expect(mapAdyenResultCode("UnknownCode")).toBe("pending");
    });
  });

  describe("normalizeAdyenPmType", () => {
    it("should normalize scheme to card", () => {
      expect(normalizeAdyenPmType("scheme")).toBe(PAYMENT_METHOD_TYPE_CARD);
    });

    it("should normalize sepadirectdebit to bank_account", () => {
      expect(normalizeAdyenPmType("sepadirectdebit")).toBe(
        PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
      );
    });

    it("should normalize ideal to bank_transfer", () => {
      expect(normalizeAdyenPmType("ideal")).toBe(
        PAYMENT_METHOD_TYPE_BANK_TRANSFER,
      );
    });

    it("should pass through unknown types as-is", () => {
      expect(normalizeAdyenPmType("klarna")).toBe("klarna");
    });

    it("should pass through another unknown type as-is", () => {
      expect(normalizeAdyenPmType("paypal")).toBe("paypal");
    });
  });
});
