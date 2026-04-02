export class CustomerSearchResponseDto {
  id!: string;
  monolithCustomerId!: string;
  name!: string;
  email!: string;
  status!: string;
  stripeCustomerId!: string | null;
  createdAt!: string;
  updatedAt!: string;
}
