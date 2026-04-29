import { Inject, Injectable, Optional } from "@nestjs/common";

export interface RawDiscountConfig {
  isDiscountedEmployee: boolean;
  flatRateCents: number;
  percentage: number;
  startDate: string | null;
  durationMonths: number | null;
}

export interface RawPayrollEmployeeBonus {
  bonusMonth: string;
  bonusCents: number;
  incrementAmountCents: number;
  createdAt: string;
}

export interface RawPayrollEmployee {
  employeeId: string;
  employeeName: string;
  salaryCents: number;
  platformFeeCents: number;
  discountConfig: RawDiscountConfig | null;
  bonuses: RawPayrollEmployeeBonus[];
}

export interface ResolvedEmployeeLineItem {
  employeeId: string;
  employeeName: string;
  customerCost: number;
  salary: number;
  platformFee: number;
  bonus: number;
  raise: number;
  discount: number;
}

export interface ResolvedBreakdown {
  employees: ResolvedEmployeeLineItem[];
  totalAmountCents: number;
}

export interface Clock {
  now(): Date;
}

export const CLOCK = "PayrollResolver.Clock";

@Injectable()
export class PayrollBreakdownResolver {
  constructor(
    @Optional()
    @Inject(CLOCK)
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  resolve(
    input: { employees?: RawPayrollEmployee[] },
    cycleStart: Date,
  ): ResolvedBreakdown {
    const employees: ResolvedEmployeeLineItem[] = [];
    let totalAmountCents = 0;

    for (const raw of input.employees ?? []) {
      const grossSalary = raw.salaryCents / 100;
      const originalPlatformFee = raw.platformFeeCents / 100;

      const discountedPlatformFee = this.applyDiscountToPlatformFee(
        cycleStart,
        originalPlatformFee,
        raw.discountConfig,
      );

      const cycleBonus = this.pickCycleBonus(raw.bonuses, cycleStart);
      const bonus = cycleBonus ? cycleBonus.bonusCents / 100 : 0;
      const raise = cycleBonus ? cycleBonus.incrementAmountCents / 100 : 0;

      const customerCost = grossSalary + discountedPlatformFee + bonus;
      const discount =
        customerCost - (grossSalary + originalPlatformFee + bonus);

      const lineItem: ResolvedEmployeeLineItem = {
        employeeId: raw.employeeId,
        employeeName: raw.employeeName,
        customerCost: Math.round(customerCost * 100),
        salary: Math.round(grossSalary * 100),
        platformFee: Math.round(originalPlatformFee * 100),
        bonus: Math.round(bonus * 100),
        raise: Math.round(raise * 100),
        discount: Math.round(discount * 100),
      };

      employees.push(lineItem);
      totalAmountCents += lineItem.customerCost;
    }

    return { employees, totalAmountCents };
  }

  private applyDiscountToPlatformFee(
    cycleStart: Date,
    platformFee: number,
    config: RawDiscountConfig | null,
  ): number {
    if (!config) {
      return platformFee;
    }

    if (!this.validateDiscount(cycleStart, config)) {
      return platformFee;
    }

    const flat = config.flatRateCents / 100;
    const discount =
      flat > 0
        ? flat
        : this.calculatePercentageDiscount(platformFee, config.percentage);
    return platformFee - discount;
  }

  private validateDiscount(
    cycleStart: Date,
    config: RawDiscountConfig,
  ): boolean {
    if (this.isPerpetualDiscount(config)) return true;
    if (this.isPerpetualDiscountWithStartDate(config)) return true;
    return this.validateLimitedDiscount(cycleStart, config);
  }

  private isPerpetualDiscount(config: RawDiscountConfig): boolean {
    return (
      config.isDiscountedEmployee &&
      config.durationMonths == null &&
      config.startDate == null
    );
  }

  private isPerpetualDiscountWithStartDate(config: RawDiscountConfig): boolean {
    if (
      !config.isDiscountedEmployee ||
      config.durationMonths != null ||
      config.startDate == null
    ) {
      return false;
    }
    // Copy the clock's return value before mutating — a memoizing clock
    // (e.g. frozen-clock fixtures) would otherwise be silently corrupted.
    const currentDate = new Date(this.clock.now());
    currentDate.setUTCHours(0, 0, 0, 0);
    const discountStartDate = new Date(config.startDate);
    discountStartDate.setUTCHours(0, 0, 0, 0);
    return currentDate >= discountStartDate;
  }

  private validateLimitedDiscount(
    cycleStart: Date,
    config: RawDiscountConfig,
  ): boolean {
    if (
      !config.isDiscountedEmployee ||
      config.durationMonths == null ||
      config.startDate == null
    ) {
      return false;
    }
    const payDate = new Date(cycleStart);
    payDate.setUTCHours(0, 0, 0, 0);
    const discountStartDate = new Date(config.startDate);
    discountStartDate.setUTCHours(0, 0, 0, 0);
    const discountEndDate = this.addMonthsClamped(
      discountStartDate,
      config.durationMonths,
    );
    return payDate >= discountStartDate && payDate < discountEndDate;
  }

  // Returns start + months, clamping the day to the target month's last day so
  // Oct 31 + 4 months yields Feb 28 (not Mar 3 from setUTCMonth overflow).
  private addMonthsClamped(start: Date, months: number): Date {
    const startYear = start.getUTCFullYear();
    const startMonth = start.getUTCMonth();
    const startDay = start.getUTCDate();

    const targetMonthIndex = startMonth + months;
    const targetYear = startYear + Math.floor(targetMonthIndex / 12);
    const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

    const lastDayOfTargetMonth = new Date(
      Date.UTC(targetYear, targetMonth + 1, 0),
    ).getUTCDate();
    const clampedDay = Math.min(startDay, lastDayOfTargetMonth);

    return new Date(Date.UTC(targetYear, targetMonth, clampedDay));
  }

  private calculatePercentageDiscount(
    platformFee: number,
    percentage: number,
  ): number {
    return percentage > 0 ? Math.ceil((percentage / 100) * platformFee) : 0;
  }

  private pickCycleBonus(
    bonuses: RawPayrollEmployeeBonus[],
    cycleStart: Date,
  ): RawPayrollEmployeeBonus | null {
    const bonusMonthStart = new Date(
      Date.UTC(cycleStart.getUTCFullYear(), cycleStart.getUTCMonth() - 1, 1),
    );
    const bonusMonthEnd = new Date(
      Date.UTC(cycleStart.getUTCFullYear(), cycleStart.getUTCMonth(), 1),
    );

    const inWindow = bonuses.filter((b) => {
      const m = new Date(b.bonusMonth);
      return m >= bonusMonthStart && m < bonusMonthEnd;
    });

    if (inWindow.length === 0) return null;

    inWindow.sort((a, b) => {
      const am = new Date(a.bonusMonth).getTime();
      const bm = new Date(b.bonusMonth).getTime();
      if (bm !== am) return bm - am;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return inWindow[0];
  }
}
