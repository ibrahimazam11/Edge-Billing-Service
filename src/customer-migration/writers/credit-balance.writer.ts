import { Injectable, Logger } from "@nestjs/common";
import { CreditsService } from "../../credits/credits.service";
import { CreditNotesRepository } from "../../credits/credit-notes.repository";
import { DRY_RUN_PLACEHOLDER_ID, toCents, type StepResult } from "../helpers";
import type { LatestPayrollInputDto } from "../dto/migrate-customer-body.dto";

export const MIGRATION_CREDIT_REASON = "monolith starting_balance migration";

export interface CreditBalanceWriteInput {
  billingCustomerId: string;
  latestPayroll?: LatestPayrollInputDto | null;
  // Live Stripe customer.balance in raw cents at migration time. Preferred over
  // latestPayroll.startingBalance when present — the latter is a historical snapshot
  // and can be stale relative to refunds / manual adjustments accumulated since the
  // last paid payroll. Sign convention matches Stripe: negative = customer has credit.
  stripeCustomerBalanceCents?: number | null;
}

@Injectable()
export class CreditBalanceWriter {
  private readonly logger = new Logger(CreditBalanceWriter.name);

  constructor(
    private readonly creditsService: CreditsService,
    private readonly creditNotesRepository: CreditNotesRepository,
  ) {}

  async write(
    input: CreditBalanceWriteInput,
    opts: { dryRun: boolean; runId: string },
  ): Promise<StepResult> {
    // C3 fix: prefer live Stripe customer.balance (sent in raw cents) over the
    // legacy historical value derived from latestPayroll.startingBalance. The legacy
    // path stays as the fallback so bodies built before this field existed still work.
    //
    // SIGN CONVENTION (raw Stripe customer.balance, identical on both inputs):
    //   < 0  → customer HAS credit (Stripe owes the customer); |value| = credit amount
    //   = 0  → no credit
    //   > 0  → customer OWES Stripe; BS does not track customer debt as credit
    // BS credit_balances.balance_cents stores positive cents (available customer credit).
    let rawCents: number;
    if (
      input.stripeCustomerBalanceCents !== null &&
      input.stripeCustomerBalanceCents !== undefined
    ) {
      if (!Number.isFinite(input.stripeCustomerBalanceCents)) {
        return {
          status: "failed",
          reason: "invalid_amount",
          error: `stripeCustomerBalanceCents not finite (${input.stripeCustomerBalanceCents})`,
        };
      }
      rawCents = Math.trunc(input.stripeCustomerBalanceCents);
    } else {
      const startingBalanceStr = input.latestPayroll?.startingBalance;
      if (
        startingBalanceStr === null ||
        startingBalanceStr === undefined ||
        startingBalanceStr === ""
      ) {
        return { status: "skipped", reason: "no_credit" };
      }
      try {
        rawCents = toCents(startingBalanceStr);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: "failed", reason: "invalid_amount", error: msg };
      }
    }

    if (rawCents > 0) {
      // Customer OWES Stripe (rare; positive customer.balance). Not a migration error —
      // BS doesn't track customer debt — but worth a structured warn so ops can spot the
      // anomaly post-wave and audit whether the debt was reconciled before the cycle ran.
      this.logger.warn({
        action: "customer-migration.credit-balance.customer_owes_stripe",
        billingCustomerId: input.billingCustomerId,
        rawCents,
      });
      return { status: "skipped", reason: "no_credit" };
    }
    if (rawCents === 0) {
      return { status: "skipped", reason: "no_credit" };
    }

    const amountCents = -rawCents;

    // B2: Idempotency based on prior credit_notes row, NOT balance value.
    // A consumed credit leaves balance=0 but the credit_notes row persists,
    // signalling migration has already run for this customer.
    // Bug 2 fix: run idempotency check on both real-run AND dry-run so the
    // preview accurately reports `already_migrated` for already-migrated
    // customers.
    //
    // Dry-run sentinel guard (spec-billing-migration-dry-run-sentinel-idempotency.md):
    // In a first-time dry-run, paymentSettings has not yet created a BS customer,
    // so the orchestrator passes DRY_RUN_PLACEHOLDER_ID instead of a UUID. Issuing
    // the SELECT in that mode crashes Postgres because the column is UUID-typed.
    // Skip the lookup — there is by definition nothing to be idempotent against
    // when no BS customer exists yet.
    if (input.billingCustomerId !== DRY_RUN_PLACEHOLDER_ID) {
      const existing = await this.creditNotesRepository.findByCustomerAndReason(
        input.billingCustomerId,
        MIGRATION_CREDIT_REASON,
      );
      if (existing) {
        return { status: "skipped", reason: "already_migrated" };
      }
    }

    const currency = input.latestPayroll?.localCurrency ?? "usd";

    if (opts.dryRun) {
      return {
        status: "succeeded",
        dryRun: true,
        planned: {
          customerId: input.billingCustomerId,
          amountCents,
          currency,
          reason: MIGRATION_CREDIT_REASON,
        },
      };
    }

    try {
      const result = await this.creditsService.issueCreditNote(
        {
          customerId: input.billingCustomerId,
          amountCents,
          reason: MIGRATION_CREDIT_REASON,
          createdBy: "migration",
        },
        `customer-migration-${opts.runId}`,
      );
      return {
        status: "succeeded",
        data: {
          creditNoteId: result.id,
          amountCents,
          currency,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({
        action: "customer-migration.credit-balance.issue_failed",
        billingCustomerId: input.billingCustomerId,
        error: msg,
      });
      return {
        status: "failed",
        reason: "issue_credit_note_failed",
        error: msg,
      };
    }
  }
}
