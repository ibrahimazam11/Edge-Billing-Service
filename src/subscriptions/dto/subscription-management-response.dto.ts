import { SubscriptionResponseDto } from "./subscription-response.dto";

export class SubscriptionManagementResponseDto extends SubscriptionResponseDto {
  customerName!: string | null;
  customerEmail!: string | null;
}
