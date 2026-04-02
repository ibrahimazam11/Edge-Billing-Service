import { HttpStatus } from "@nestjs/common";
import { BillingException } from "../common/exceptions/billing.exception";

export class InvoiceNotFinalizedException extends BillingException {
  constructor(invoiceId: string, currentStatus: string) {
    super(
      `Invoice ${invoiceId} is in '${currentStatus}' status — must be finalized before payment`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      { errorCode: "INVOICE_NOT_FINALIZED", invoiceId, currentStatus },
    );
  }
}
