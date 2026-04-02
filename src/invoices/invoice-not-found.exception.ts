import { HttpStatus } from "@nestjs/common";
import { BillingException } from "../common/exceptions/billing.exception";

export class InvoiceNotFoundException extends BillingException {
  constructor(invoiceId: string) {
    super(`Invoice not found: ${invoiceId}`, HttpStatus.NOT_FOUND);
  }
}
