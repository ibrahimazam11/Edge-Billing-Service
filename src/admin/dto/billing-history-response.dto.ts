import type { BillingHistoryType } from "./billing-history-types.constants";

export class BillingHistoryResponseDto {
  id!: string;
  type!: BillingHistoryType;
  referenceId!: string;
  description!: string;
  amountCents!: number;
  currency!: string;
  status!: string;
  createdAt!: string;
}
