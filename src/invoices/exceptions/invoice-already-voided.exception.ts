import { HttpStatus } from "@nestjs/common";
import { BillingException } from "../../common/exceptions/billing.exception";

export class InvoiceAlreadyVoidedException extends BillingException {
  constructor(invoiceId: string) {
    super(`Invoice ${invoiceId} has already been voided`, HttpStatus.CONFLICT, {
      errorCode: "INVOICE_ALREADY_VOIDED",
    });
  }
}
