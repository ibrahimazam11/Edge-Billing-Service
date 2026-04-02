import { IsIn, IsNotEmpty, IsString } from "class-validator";

const USER_SETTABLE_STATUSES = ["active", "paused", "canceled"] as const;

export type UserSettableStatus = (typeof USER_SETTABLE_STATUSES)[number];

export class UpdateSubscriptionDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(USER_SETTABLE_STATUSES)
  status!: UserSettableStatus;
}
