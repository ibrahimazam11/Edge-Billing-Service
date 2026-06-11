import { Injectable, Logger } from "@nestjs/common";
import { SurchargeConfigRepository } from "../../surcharges/surcharge-config.repository";
import { DRY_RUN_PLACEHOLDER_ID, toCents, type StepResult } from "../helpers";
import type { SurchargeConfigInputDto } from "../dto/migrate-customer-body.dto";

export interface SurchargeWriteInput {
  billingCustomerId: string;
  surchargeConfig?: SurchargeConfigInputDto | null;
}

function mapSurchargeType(t: string): "percentage" | "flat_fee" {
  if (t === "Percentage") return "percentage";
  return "flat_fee";
}

@Injectable()
export class SurchargeWriter {
  private readonly logger = new Logger(SurchargeWriter.name);

  constructor(
    private readonly surchargeConfigRepository: SurchargeConfigRepository,
  ) {}

  async write(
    input: SurchargeWriteInput,
    opts: { dryRun: boolean; runId: string },
  ): Promise<StepResult> {
    void opts;
    if (!input.surchargeConfig) {
      return { status: "skipped", reason: "no_config" };
    }

    const cfg = input.surchargeConfig;

    let surchargeValueCents: number;
    try {
      surchargeValueCents = toCents(cfg.surchargeValue);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "failed",
        reason: "invalid_surcharge_value",
        error: msg,
      };
    }

    // Bug 2 fix: run idempotency check on both real-run AND dry-run so the
    // preview accurately reports `already_migrated`.
    //
    // Dry-run sentinel guard (spec-billing-migration-dry-run-sentinel-idempotency.md):
    // In a first-time dry-run, paymentSettings has not yet created a BS customer,
    // so the orchestrator passes DRY_RUN_PLACEHOLDER_ID instead of a UUID. Issuing
    // the SELECT in that mode crashes Postgres because the column is UUID-typed.
    // Skip the lookup — there is by definition nothing to be idempotent against
    // when no BS customer exists yet. Real UUIDs (real-run, OR dry-run on an
    // already-migrated customer where paymentSettings found the existing row)
    // still run the check.
    if (input.billingCustomerId !== DRY_RUN_PLACEHOLDER_ID) {
      const existing = await this.surchargeConfigRepository.findByCustomer(
        input.billingCustomerId,
      );
      if (existing) {
        return { status: "skipped", reason: "already_migrated" };
      }
    }

    const surchargeType = mapSurchargeType(cfg.surchargeType);

    if (opts.dryRun) {
      return {
        status: "succeeded",
        dryRun: true,
        planned: {
          customerId: input.billingCustomerId,
          allowCreditCard: cfg.allowCreditCard,
          surchargeType,
          surchargeValue: surchargeValueCents,
        },
      };
    }

    try {
      await this.surchargeConfigRepository.upsert(input.billingCustomerId, {
        allowCreditCard: cfg.allowCreditCard,
        surchargeType,
        surchargeValue: surchargeValueCents,
        reason: cfg.reason ?? null,
        notes: cfg.notes ?? null,
        enabledBy: cfg.enabledByUserId ?? null,
      });
      return {
        status: "succeeded",
        data: { surchargeType, surchargeValueCents },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({
        action: "customer-migration.surcharge.write_failed",
        billingCustomerId: input.billingCustomerId,
        error: msg,
      });
      return { status: "failed", reason: "upsert_failed", error: msg };
    }
  }
}
