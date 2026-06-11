import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export class BillingAddressDto {
  @IsOptional() @IsString() line1?: string;
  @IsOptional() @IsString() line2?: string | null;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() postalCode?: string;
  @IsOptional() @IsString() country?: string;
}

export class CustomerInputDto {
  @IsString() @IsNotEmpty() monolithCustomerId!: string;
  @IsString() @IsNotEmpty() companyName!: string;
  @IsEmail() contactEmail!: string;
  @IsInt() @Min(1) @Max(31) trialEndDate!: number;
  @IsBoolean() isPrepaid!: boolean;
  @IsIn(["enabled", "disabled", "churned"]) status!:
    | "enabled"
    | "disabled"
    | "churned";

  @IsOptional()
  @ValidateNested()
  @Type(() => BillingAddressDto)
  billingAddress?: BillingAddressDto | null;
}

export class PaymentSettingsInputDto {
  @IsString() @IsNotEmpty() stripeCustomerId!: string;
  @IsIn(["ACH", "CREDIT_CARD", "CHEQUE"]) paymentMethodType!:
    | "ACH"
    | "CREDIT_CARD"
    | "CHEQUE";

  @IsOptional() @IsString() mandateId?: string | null;
  @IsOptional() @IsString() subscriptionId?: string | null;
  @IsOptional() @IsString() subscriptionItemId?: string | null;
}

export class SurchargeConfigInputDto {
  @IsBoolean() allowCreditCard!: boolean;
  @IsIn(["Percentage", "Flat_Rate"]) surchargeType!: "Percentage" | "Flat_Rate";
  @IsString() @IsNotEmpty() surchargeValue!: string;
  @IsOptional() @IsString() reason?: string | null;
  @IsOptional() @IsString() notes?: string | null;
  @IsOptional() @IsString() enabledByUserId?: string | null;
}

export class LatestPayrollInputDto {
  @IsString() @IsNotEmpty() totalAmount!: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  localCurrency?: string | null;

  @IsOptional() @IsString() startingBalance?: string | null;

  @IsDateString() payrollMonth!: string;
}

export class PayrollEmployeeInputDto {
  @IsString() @IsNotEmpty() payrollId!: string;
  @IsString() @IsNotEmpty() employeeName!: string;
  @IsString() @IsNotEmpty() baseSalary!: string;

  // Cost components (nullable — historical data has nulls especially for platformFee pre-platform-fee era).
  // Stored on BS for parity with monolith invoice rendering math; live billing uses baseSalary.
  @IsOptional() @IsString() paidGrossSalary?: string | null;
  @IsOptional() @IsString() bonus?: string | null;
  @IsOptional() @IsString() platformFee?: string | null;
}

export class PayrollInputDto {
  @IsString() @IsNotEmpty() customerPayrollId!: string;

  @IsDateString() payrollMonth!: string;

  @IsString() @IsNotEmpty() totalAmount!: string;

  @IsString() @IsNotEmpty() status!: string;

  @IsBoolean() failure!: boolean;

  @IsOptional() @IsString() failureReason?: string | null;

  @IsOptional() @IsDateString() paymentDate?: string | null;

  @IsOptional() @IsDateString() paidOn?: string | null;

  @IsOptional() @IsString() creditCardSurcharge?: string | null;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  localCurrency?: string | null;

  @IsOptional() @IsDateString() deletedAt?: string | null;

  // Per-row starting balance (sign preserved verbatim from monolith Customer_Payroll.Starting_Balance —
  // negative when credit was applied). BS persists into invoice metadata for PDF/webview rendering.
  @IsOptional() @IsString() startingBalance?: string | null;

  // Monolith provenance — persisted into invoice metadata for cross-system reconciliation.
  @IsOptional() @IsString() invoiceId?: string | null;
  @IsOptional() @IsString() invoiceUrl?: string | null;
  @IsOptional() @IsString() referenceNumber?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PayrollEmployeeInputDto)
  employees!: PayrollEmployeeInputDto[];
}

export class ChargeLineItemInputDto {
  @IsOptional() @IsString() fee?: string | null;
  @IsOptional() @IsString() implementationFee?: string | null;
  @IsOptional() @IsString() discount?: string | null;
  @IsOptional() @IsString() total?: string | null;
  @IsOptional() @IsString() employeeName?: string | null;
  @IsOptional() @IsString() notes?: string | null;
  @IsOptional() @IsString() type?: string | null;
}

export class ChargeInputDto {
  @IsNumber() chargeId!: number;
  @IsString() @IsNotEmpty() amount!: string;
  @IsIn(["ONBOARDING", "ONE_TIME"]) chargeType!: "ONBOARDING" | "ONE_TIME";
  @IsString() @IsNotEmpty() paymentStatus!: string;

  @IsOptional() @IsDateString() paymentDate?: string | null;
  @IsOptional() @IsString() failureReason?: string | null;
  @IsOptional() @IsString() creditCardSurcharge?: string | null;
  @IsOptional() @IsDateString() deletedAt?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChargeLineItemInputDto)
  lineItems!: ChargeLineItemInputDto[];
}

export class MigrateCustomerBodyDto {
  @IsOptional() @IsBoolean() dryRun?: boolean;

  @ValidateNested()
  @Type(() => CustomerInputDto)
  customer!: CustomerInputDto;

  @ValidateNested()
  @Type(() => PaymentSettingsInputDto)
  paymentSettings!: PaymentSettingsInputDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SurchargeConfigInputDto)
  surchargeConfig?: SurchargeConfigInputDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => LatestPayrollInputDto)
  latestPayroll?: LatestPayrollInputDto | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PayrollInputDto)
  payrolls!: PayrollInputDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChargeInputDto)
  charges!: ChargeInputDto[];
}

export class RollbackCustomerBodyDto {
  @IsOptional() @IsObject() context?: Record<string, unknown>;
}
