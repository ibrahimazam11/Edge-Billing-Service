import { HttpStatus } from "@nestjs/common";
import { BillingException } from "../../common/exceptions/billing.exception";

export class InvoiceNotFinalizedException extends BillingException {
  constructor(invoiceId: string) {
    super(`Invoice ${invoiceId} is not finalized`, HttpStatus.CONFLICT, {
      errorCode: "INVOICE_NOT_FINALIZED",
    });
  }
}
