import { BusinessRuleViolationException } from "./billing.exception";

export class CreditExceedsInvoiceException extends BusinessRuleViolationException {
  constructor(amountCents: number, invoiceTotalCents: number) {
    super(
      `Credit amount ${amountCents} exceeds invoice total ${invoiceTotalCents}`,
      { errorCode: "CREDIT_EXCEEDS_INVOICE", amountCents, invoiceTotalCents },
    );
  }
}
