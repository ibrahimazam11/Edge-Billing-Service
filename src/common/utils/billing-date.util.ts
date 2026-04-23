/**
 * Billing date calculation utilities.
 *
 * Two separate concerns:
 *   1. Billing cycle — the subscription period (e.g., 10th→10th, 1st→1st)
 *   2. Charge initiation — when payment is collected (invoice due date)
 *
 * `chargeDay` = day-of-month (1-31) the charge is initiated
 *              (maps to monolith `Trial_End_Date`)
 *
 * For chargeDay in PAYROLL_ADVANCE_DAYS the billing cycle shifts to 1st→1st
 * while the charge still happens on the original day of the prior month.
 */

/** Days where the billing cycle shifts to 1st-of-month (mirrors monolith PAYROLL_MONTH_DATE_ADJUSTMENT config) */
const DEFAULT_PAYROLL_ADVANCE_DAYS = [28, 29, 30, 31];

function loadPayrollAdvanceDays(): readonly number[] {
  const envVal = process.env.PAYROLL_ADVANCE_DAYS;
  if (envVal) {
    try {
      const parsed: unknown = JSON.parse(envVal);
      if (
        Array.isArray(parsed) &&
        parsed.every((n: unknown) => typeof n === "number")
      ) {
        return Object.freeze(parsed);
      }
    } catch {
      /* fall through to default */
    }
  }
  return Object.freeze(DEFAULT_PAYROLL_ADVANCE_DAYS);
}

export const PAYROLL_ADVANCE_DAYS: readonly number[] = loadPayrollAdvanceDays();

/**
 * Derive the billing-cycle start day from chargeDay.
 * Boundary customers (chargeDay 28-31) get a 1st→1st cycle.
 * Everyone else cycles on their chargeDay (e.g., 10th→10th).
 */
export function getBillingCycleDay(chargeDay: number): number {
  return PAYROLL_ADVANCE_DAYS.includes(chargeDay) ? 1 : chargeDay;
}

/** Return the last day of a given month (handles Feb, leap years, 30/31-day months). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Clamp a day to the maximum valid day for the given year/month. */
function clampDay(day: number, year: number, month: number): number {
  return Math.min(day, daysInMonth(year, month));
}

/** Add N months to a UTC date, clamping the day for shorter months. */
function addMonths(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const d = date.getUTCDate();
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const clampedDay = clampDay(d, targetYear, targetMonth);
  return new Date(Date.UTC(targetYear, targetMonth, clampedDay));
}

/**
 * Calculate the invoice due date (charge initiation date) for a billing period.
 *
 * @param billingPeriodStart - 1st day of the billing cycle (e.g., April 10 for a 10th→10th customer)
 * @param chargeDay          - day-of-month the charge is initiated (monolith Trial_End_Date)
 * @param isPrepaid          - true = charge at/before cycle start; false = charge 1 month later
 */
export function calculateInvoiceDueDate(
  billingPeriodStart: Date,
  chargeDay: number,
  isPrepaid: boolean,
): Date {
  const bpYear = billingPeriodStart.getUTCFullYear();
  const bpMonth = billingPeriodStart.getUTCMonth();

  let dueYear: number;
  let dueMonth: number;

  const isBoundary = PAYROLL_ADVANCE_DAYS.includes(chargeDay);

  if (isBoundary) {
    // Boundary customer (cycle = 1st→1st): charge falls in the month BEFORE the billing period
    dueMonth = bpMonth - 1;
    dueYear = bpYear;
    if (dueMonth < 0) {
      dueMonth = 11;
      dueYear -= 1;
    }
  } else {
    // Mid-month or day 1-27 customer: charge falls in the same month as billingPeriodStart
    dueMonth = bpMonth;
    dueYear = bpYear;
  }

  const clampedDay = clampDay(chargeDay, dueYear, dueMonth);
  let dueDate = new Date(Date.UTC(dueYear, dueMonth, clampedDay));

  if (!isPrepaid) {
    dueDate = addMonths(dueDate, 1);
  }

  return dueDate;
}

/**
 * Calculate the next billing period and due date from a reference date (typically today).
 * Used for reactivation / enableCustomer — replicates monolith generatePaymentDate + generatePayrollMonth.
 *
 * @param today     - current date
 * @param chargeDay - day-of-month the charge is initiated
 * @param isPrepaid - prepaid or postpaid
 */
export function calculateNextBillingPeriod(
  today: Date,
  chargeDay: number,
  isPrepaid: boolean,
): { billingPeriodStart: Date; billingPeriodEnd: Date; dueDate: Date } {
  const todayYear = today.getUTCFullYear();
  const todayMonth = today.getUTCMonth();
  const todayDay = today.getUTCDate();

  // Step 1: Find next occurrence of chargeDay (same logic as monolith generatePaymentDate / dateAdjustment)
  let paymentYear = todayYear;
  let paymentMonth = todayMonth;
  const clampedToday = clampDay(chargeDay, paymentYear, paymentMonth);

  if (todayDay >= clampedToday) {
    // Charge day has passed this month → advance to next month
    paymentMonth += 1;
    if (paymentMonth > 11) {
      paymentMonth = 0;
      paymentYear += 1;
    }
  }

  const paymentDay = clampDay(chargeDay, paymentYear, paymentMonth);
  const nextPaymentDate = new Date(
    Date.UTC(paymentYear, paymentMonth, paymentDay),
  );

  // Step 2: Derive billing period start from payment date
  //   (inverse of monolith generatePayrollMonth)
  const cycleDay = getBillingCycleDay(chargeDay);
  const isBoundary = PAYROLL_ADVANCE_DAYS.includes(chargeDay);

  let bpStartYear = paymentYear;
  let bpStartMonth = paymentMonth;

  if (isBoundary) {
    // Boundary days: payroll month = next month's 1st
    bpStartMonth += 1;
    if (bpStartMonth > 11) {
      bpStartMonth = 0;
      bpStartYear += 1;
    }
  }

  const bpStartDay = clampDay(cycleDay, bpStartYear, bpStartMonth);
  let billingPeriodStart = new Date(
    Date.UTC(bpStartYear, bpStartMonth, bpStartDay),
  );

  // Step 3: Postpaid adjustment — billing period start shifts +1 month
  if (!isPrepaid) {
    billingPeriodStart = addMonths(billingPeriodStart, 1);
  }

  // Step 4: Billing period end = start + 1 month
  const billingPeriodEnd = addMonths(billingPeriodStart, 1);

  // Step 5: Due date
  let dueDate = nextPaymentDate;
  if (!isPrepaid) {
    dueDate = addMonths(nextPaymentDate, 1);
  }

  return { billingPeriodStart, billingPeriodEnd, dueDate };
}
