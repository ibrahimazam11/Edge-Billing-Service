import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";

export const BULK_SUBSCRIPTION_ACTIONS = ["pause", "cancel"] as const;
export type BulkSubscriptionAction = (typeof BULK_SUBSCRIPTION_ACTIONS)[number];

export class BulkSubscriptionOperationDto {
  @IsNotEmpty()
  @IsIn(BULK_SUBSCRIPTION_ACTIONS)
  action!: BulkSubscriptionAction;

  @IsArray()
  @IsUUID(undefined, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  subscriptionIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
