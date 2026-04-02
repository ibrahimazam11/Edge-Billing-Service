import { BusinessRuleViolationException } from "../common/exceptions/billing.exception";

export function validateRefundAmount(
  chargeAmountCents: number,
  existingRefundsTotalCents: number,
  requestedAmountCents: number,
): void {
  const totalAfterRefund = existingRefundsTotalCents + requestedAmountCents;
  if (totalAfterRefund > chargeAmountCents) {
    throw new BusinessRuleViolationException(
      `Total refunds (${totalAfterRefund}) would exceed charge amount (${chargeAmountCents})`,
      {
        chargeAmountCents,
        existingRefundsTotalCents,
        requestedAmountCents,
        totalAfterRefund,
      },
    );
  }
}
