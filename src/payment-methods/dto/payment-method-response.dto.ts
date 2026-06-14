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
  // Carries provider-specific extras such as { mandate_id } for ACH bank accounts.
  // Read by ChargesService to forward the mandate to Stripe on charge.
  metadata!: Record<string, unknown> | null;
  createdAt!: string;
  updatedAt!: string;
}
