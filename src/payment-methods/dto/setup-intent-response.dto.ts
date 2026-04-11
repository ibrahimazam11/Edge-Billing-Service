export interface SetupIntentResponseDto {
  setupIntentId: string;
  clientSecret: string;
  status: string;
  paymentMethodId: string | null;
}
