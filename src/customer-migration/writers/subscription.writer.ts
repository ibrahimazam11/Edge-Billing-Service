import { Inject, Injectable, Logger } from "@nestjs/common";
import { DRIZZLE_PROVIDER } from "../../database/database.provider";
import type { DrizzleDatabase } from "../../database/types";
import { subscriptions } from "../../database/schema/subscriptions";
import { generateId } from "../../common/utils/uuid.util";
import { SubscriptionsRepository } from "../../subscriptions/subscriptions.repository";
import { CustomersRepository } from "../../customers/customers.repository";
import { toCents, DRY_RUN_PLACEHOLDER_ID, type StepResult } from "../helpers";
import type {
  CustomerInputDto,
  LatestPayrollInputDto,
  PaymentSettingsInputDto,
  SubscriptionTimingInputDto,
} from "../dto/migrate-customer-body.dto";

export interface SubscriptionWriteInput {
  billingCustomerId: string;
  paymentSettings: PaymentSettingsInputDto;
  latestPayroll?: LatestPayrollInputDto | null;
  customer?: CustomerInputDto;
  // First-cycle dates sourced from monolith's latest Customer_Payroll row. When present,
  // writer uses them verbatim instead of computeDueDate / computeBillingCycle.
  subscriptionTiming?: SubscriptionTimingInputDto;
}

/**
 * Cycle math per spec-billing-migration-subscription-cycle-prepaid-postpaid.md:
 *
 * Prepaid (isPrepaid=true): BS owns the NEXT month's cycle. Monolith already
 *   charged the current month at the start, so the next BS draft is for the
 *   following month.
 * Postpaid (isPrepaid=false): BS owns the CURRENT month's cycle. Postpaid bills
 *   at the END of the cycle (next chargeDay), and monolith has not yet charged
 *   for it.
 *
 * chargeDay ∈ [28..31] normalizes the literal day to 1 (Feb has 28 days etc.).
 *
 * Examples (today = 2026-05-25):
 *   prepaid + chargeDay=1   → 2026-06-01 → 2026-07-01
 *   postpaid + chargeDay=1  → 2026-05-01 → 2026-06-01
 *   prepaid + chargeDay=28  → 2026-06-01 → 2026-07-01
 *   postpaid + chargeDay=28 → 2026-05-01 → 2026-06-01
 */
export function computeBillingCycle(
  chargeDay: number,
  fromDate: Date,
  isPrepaid: boolean,
): { billingPeriodStart: Date; billingPeriodEnd: Date } {
  const y = fromDate.getUTCFullYear();
  const m = fromDate.getUTCMonth();
  // Postpaid → anchor on current month (offset 0); Prepaid → next month (offset 1).
  const startOffset = isPrepaid ? 1 : 0;
  // chargeDay ∈ [28..31] normalizes the literal day to 1; the month offset is
  // unchanged.
  const day = chargeDay >= 28 && chargeDay <= 31 ? 1 : chargeDay;
  return {
    billingPeriodStart: new Date(Date.UTC(y, m + startOffset, day)),
    billingPeriodEnd: new Date(Date.UTC(y, m + startOffset + 1, day)),
  };
}

/**
 * Compute the actual calendar charge date (BS subscriptions.nextBillingDate)
 * from chargeDay relative to today.
 *
 * Independent of isPrepaid — both modes converge on the same due-date value
 * for any given chargeDay. The prepaid/postpaid distinction lives in the
 * cycle math, not the due-date math.
 *
 * Rule (see spec-billing-migration-due-date-from-chargeday.md):
 *   - chargeDay 1..27 → Nth of next month
 *   - chargeDay 28..31 → Nth of current month IF that month has the Nth;
 *     otherwise default to 1st of next month
 *
 * The 28..31 branch is unified to avoid silent JS date overflow. Naively
 * constructing `Date.UTC(y, m, 30)` for February rolls forward to March 2;
 * the unified rule mirrors the chargeDay=31 fallback for all of 28..31
 * (added in change-log entry for chargeDay 29/30 + Feb edge case).
 *
 * Examples (today = 2026-05-25):
 *   chargeDay=1   → 2026-06-01
 *   chargeDay=15  → 2026-06-15
 *   chargeDay=28  → 2026-05-28
 *   chargeDay=30  → 2026-05-30
 *   chargeDay=31  → 2026-05-31 (May has 31)
 *
 * Edge cases:
 *   chargeDay=29 + today=2026-02-15 (Feb 28 non-leap) → 2026-03-01 (default)
 *   chargeDay=29 + today=2024-02-15 (Feb 29 leap)    → 2024-02-29
 *   chargeDay=30 + today=2026-02-15                  → 2026-03-01 (default)
 *   chargeDay=31 + today=2026-04-15 (April 30)       → 2026-05-01 (default)
 */
export function computeDueDate(chargeDay: number, fromDate: Date): Date {
  const y = fromDate.getUTCFullYear();
  const m = fromDate.getUTCMonth();
  if (chargeDay >= 1 && chargeDay <= 27) {
    return new Date(Date.UTC(y, m + 1, chargeDay));
  }
  if (chargeDay >= 28 && chargeDay <= 31) {
    // Last day of current month via the (m+1, 0) trick. If the literal
    // chargeDay doesn't exist in this month, default to 1st of next month.
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    if (lastDay >= chargeDay) {
      return new Date(Date.UTC(y, m, chargeDay));
    }
    return new Date(Date.UTC(y, m + 1, 1));
  }
  // chargeDay out of [1..31] is caught upstream by the writer's validation
  // (P6 invalid_charge_day). Returning a safe fallback here keeps the helper
  // total without masking the upstream error path.
  return new Date(Date.UTC(y, m + 1, 1));
}

@Injectable()
export class SubscriptionWriter {
  private readonly logger = new Logger(SubscriptionWriter.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    private readonly subscriptionsRepository: SubscriptionsRepository,
    private readonly customersRepository: CustomersRepository,
  ) {}

  async write(
    input: SubscriptionWriteInput,
    opts: { dryRun: boolean; runId: string },
  ): Promise<StepResult> {
    if (!input.latestPayroll) {
      return { status: "failed", reason: "no_run_rate" };
    }

    let amountCents: number;
    try {
      amountCents = toCents(input.latestPayroll.totalAmount);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "failed", reason: "invalid_run_rate", error: msg };
    }

    const currency = input.latestPayroll.localCurrency ?? "usd";

    // Look up the customer row to read chargeDay/isPrepaid (set by payment-settings writer).
    let chargeDay: number;
    let isPrepaid: boolean;

    const isDryRunPlaceholder =
      opts.dryRun && input.billingCustomerId === DRY_RUN_PLACEHOLDER_ID;

    if (isDryRunPlaceholder) {
      // P13: Dry-run with no real billingCustomerId — read chargeDay and
      // isPrepaid from the body's customer object so the cycle preview is
      // accurate. Fall back to safe defaults only if the body is absent.
      chargeDay = input.customer?.trialEndDate ?? 1;
      isPrepaid = input.customer?.isPrepaid ?? true;
    } else {
      const customerRow = await this.customersRepository.findById(
        input.billingCustomerId,
      );
      if (!customerRow) {
        return { status: "failed", reason: "customer_not_found" };
      }
      chargeDay = customerRow.chargeDay;
      isPrepaid = customerRow.isPrepaid;
    }

    // P6: validate chargeDay
    if (!Number.isInteger(chargeDay) || chargeDay < 1 || chargeDay > 31) {
      return {
        status: "failed",
        reason: "invalid_charge_day",
        error: `chargeDay=${chargeDay} out of [1..31]`,
      };
    }

    // B3 + P11: Idempotency check with explicit edge-case failure reasons.
    // Bug 2 fix: run on dry-run too, but skip when billingCustomerId is the
    // dry-run placeholder (no real customer row exists yet so an active-sub
    // lookup would be meaningless).
    if (!isDryRunPlaceholder) {
      const active =
        await this.subscriptionsRepository.findByCustomerAndStatuses(
          input.billingCustomerId,
          ["active"],
        );

      // P11: more than one active subscription is a corrupt state — refuse
      // to write and surface for operator investigation.
      if (active.length > 1) {
        return {
          status: "failed",
          reason: "multiple_active_subscriptions",
          error: `customer ${input.billingCustomerId} has ${active.length} active subscriptions`,
        };
      }

      if (active.length === 1) {
        const existing = active[0];
        const md = (existing.metadata ?? {}) as Record<string, unknown>;
        const existingMonolithSubId = md["monolith_subscription_id"] as
          | string
          | null
          | undefined;
        const incomingSubId = paymentSettingsSubId(input.paymentSettings);

        // P11: incoming subscriptionId is null — cannot match to existing
        // sub; fail loud.
        if (!incomingSubId) {
          return {
            status: "failed",
            reason: "incoming_subscription_id_null",
            error: `customer ${input.billingCustomerId} has an active subscription but body's paymentSettings.subscriptionId is null`,
          };
        }

        // P11: existing sub has no monolith_subscription_id in metadata —
        // means it wasn't created by migration; surface conflict.
        if (!existingMonolithSubId) {
          return {
            status: "failed",
            reason: "existing_sub_without_metadata",
            error: `customer ${input.billingCustomerId} has an active subscription without metadata.monolith_subscription_id`,
          };
        }

        // B3: id matches → already migrated, idempotent skip.
        if (existingMonolithSubId === incomingSubId) {
          return { status: "skipped", reason: "already_migrated" };
        }

        // B3: id mismatch — non-migration sub already exists; conflict.
        return {
          status: "failed",
          reason: "subscription_conflict",
          error: `customer ${input.billingCustomerId} already has an active subscription with a different monolith_subscription_id (existing=${existingMonolithSubId}, incoming=${incomingSubId})`,
        };
      }
      // active.length === 0 → proceed to write below.
    }

    // Round 2: prefer monolith-sourced first-cycle dates when present (sourced from the
    // latest Customer_Payroll row's Payment_Date + Payroll_Month). Falls back to BS-side
    // compute helpers when absent so older callers / non-migration flows keep working.
    let billingPeriodStart: Date;
    let billingPeriodEnd: Date;
    let nextBillingDate: Date;
    const timing = input.subscriptionTiming;
    if (timing) {
      const parsedNext = new Date(timing.nextBillingDate);
      const parsedStart = new Date(timing.billingPeriodStart);
      const parsedEnd = new Date(timing.billingPeriodEnd);
      if (
        Number.isNaN(parsedNext.getTime()) ||
        Number.isNaN(parsedStart.getTime()) ||
        Number.isNaN(parsedEnd.getTime())
      ) {
        return {
          status: "failed",
          reason: "invalid_subscription_timing",
          error: `subscriptionTiming has invalid ISO dates`,
        };
      }
      nextBillingDate = parsedNext;
      billingPeriodStart = parsedStart;
      billingPeriodEnd = parsedEnd;
    } else {
      const today = new Date();
      const cycle = computeBillingCycle(chargeDay, today, isPrepaid);
      billingPeriodStart = cycle.billingPeriodStart;
      billingPeriodEnd = cycle.billingPeriodEnd;
      nextBillingDate = computeDueDate(chargeDay, today);
    }

    const monolithSubId = paymentSettingsSubId(input.paymentSettings);

    if (opts.dryRun) {
      return {
        status: "succeeded",
        dryRun: true,
        planned: {
          customerId: input.billingCustomerId,
          amountCents,
          currency,
          chargeDay,
          isPrepaid,
          billingPeriodStart: billingPeriodStart.toISOString(),
          billingPeriodEnd: billingPeriodEnd.toISOString(),
          nextBillingDate: nextBillingDate.toISOString(),
          monolithSubscriptionId: monolithSubId,
        },
      };
    }

    const now = new Date();
    const subscriptionId = generateId();

    try {
      await this.db.insert(subscriptions).values({
        id: subscriptionId,
        customerId: input.billingCustomerId,
        planName: "monolith-migration",
        status: "active",
        amountCents,
        currency,
        billingInterval: "monthly",
        billingPeriodStart,
        billingPeriodEnd,
        nextBillingDate,
        stripeSubscriptionId: monolithSubId ?? null,
        metadata: {
          monolith_subscription_id: monolithSubId ?? null,
          stripe_subscription_id: monolithSubId ?? null,
          monolith_subscription_item_id:
            input.paymentSettings.subscriptionItemId ?? null,
        },
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({
        action: "customer-migration.subscription.insert_failed",
        billingCustomerId: input.billingCustomerId,
        error: msg,
      });
      return { status: "failed", reason: "insert_failed", error: msg };
    }

    return {
      status: "succeeded",
      data: {
        subscriptionId,
        amountCents,
        currency,
        billingPeriodStart: billingPeriodStart.toISOString(),
        billingPeriodEnd: billingPeriodEnd.toISOString(),
      },
    };
  }
}

function paymentSettingsSubId(
  ps: PaymentSettingsInputDto,
): string | null | undefined {
  return ps.subscriptionId ?? null;
}
