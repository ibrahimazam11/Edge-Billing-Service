export class PaymentMethodResponseDto {
  id!: string;
  customerId!: string;
  stripePaymentMethodId!: string;
  type!: string;
  isDefault!: boolean;
  lastFour!: string | null;
  brand!: string | null;
  bankName!: string | null;
  expiryMonth!: number | null;
  expiryYear!: number | null;
  fallbackOrder!: number | null;
  gatewayProvider!: string;
  status!: string;
  // Exposed so the monolith's migration post-flight can verify ACH mandate continuity
  // (it asserts `metadata.mandate_id` is present on the default PM after migration).
  metadata!: Record<string, unknown> | null;
  createdAt!: string;
  updatedAt!: string;
}
