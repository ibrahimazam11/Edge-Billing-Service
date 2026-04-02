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
  createdAt!: string;
  updatedAt!: string;
}
