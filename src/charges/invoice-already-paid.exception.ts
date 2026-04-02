import { HttpStatus } from "@nestjs/common";
import { BillingException } from "../common/exceptions/billing.exception";

export class InvoiceAlreadyPaidException extends BillingException {
  constructor(invoiceId: string) {
    super(`Invoice already paid: ${invoiceId}`, HttpStatus.CONFLICT, {
      errorCode: "INVOICE_ALREADY_PAID",
      invoiceId,
    });
  }
}
