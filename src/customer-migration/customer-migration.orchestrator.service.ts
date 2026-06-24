import { Injectable, Logger } from "@nestjs/common";
import { generateId } from "../common/utils/uuid.util";
import { CustomersRepository } from "../customers/customers.repository";
import { PaymentSettingsWriter } from "./writers/payment-settings.writer";
import { CreditBalanceWriter } from "./writers/credit-balance.writer";
import { SurchargeWriter } from "./writers/surcharge.writer";
import { PayrollsWriter } from "./writers/payrolls.writer";
import { ChargesWriter } from "./writers/charges.writer";
import { SubscriptionWriter } from "./writers/subscription.writer";
import { CustomerMigrationLogsRepository } from "./customer-migration-logs.repository";
import { DRY_RUN_PLACEHOLDER_ID, type StepResult } from "./helpers";
import type { MigrateCustomerBodyDto } from "./dto/migrate-customer-body.dto";

export type StepName =
  | "paymentSettings"
  | "creditBalance"
  | "surcharge"
  | "payrolls"
  | "charges"
  | "subscription";

export interface OrchestratorResult {
  status: "succeeded" | "skipped" | "failed";
  billingCustomerId?: string;
  runId: string;
  failedStep?: StepName;
  error?: string;
  reason?: string;
  stepResults: Partial<Record<StepName, StepResult>>;
}

@Injectable()
export class CustomerMigrationOrchestratorService {
  private readonly logger = new Logger(
    CustomerMigrationOrchestratorService.name,
  );

  constructor(
    private readonly customersRepository: CustomersRepository,
    private readonly paymentSettingsWriter: PaymentSettingsWriter,
    private readonly creditBalanceWriter: CreditBalanceWriter,
    private readonly surchargeWriter: SurchargeWriter,
    private readonly payrollsWriter: PayrollsWriter,
    private readonly chargesWriter: ChargesWriter,
    private readonly subscriptionWriter: SubscriptionWriter,
    private readonly logsRepository: CustomerMigrationLogsRepository,
  ) {}

  async migrate(
    monolithCustomerId: string,
    body: MigrateCustomerBodyDto,
  ): Promise<OrchestratorResult> {
    const runId = generateId();
    const dryRun = body.dryRun === true;
    const stepResults: Partial<Record<StepName, StepResult>> = {};

    this.logger.log({
      action: "customer-migration.start",
      monolithCustomerId,
      runId,
      dryRun,
    });

    // Whole-flow already-migrated short-circuit. Bug 2 fix: runs for both
    // real-run AND dry-run so dry-run preview accurately reports skipped
    // steps for already-migrated customers.
    {
      const existing =
        await this.customersRepository.findByMonolithId(monolithCustomerId);
      if (existing) {
        const skipped: StepResult = {
          status: "skipped",
          reason: "already_migrated",
        };
        stepResults.paymentSettings = skipped;
        stepResults.creditBalance = skipped;
        stepResults.surcharge = skipped;
        stepResults.payrolls = skipped;
        stepResults.charges = skipped;
        stepResults.subscription = skipped;

        // Bug 1 fix: do not write migration_logs on dry-run.
        if (!dryRun) {
          await this.safeLog({
            runId,
            scriptName: "customer-migration-orchestrator",
            monolithCustomerId,
            billingCustomerId: existing.id,
            status: "skipped",
            details: { reason: "already_migrated" },
          });
        }

        return {
          status: "skipped",
          billingCustomerId: existing.id,
          runId,
          reason: "already_migrated",
          stepResults,
        };
      }
    }

    // Step 1: paymentSettings
    const psResult = await this.paymentSettingsWriter.write(
      { customer: body.customer, paymentSettings: body.paymentSettings },
      { dryRun, runId },
    );
    stepResults.paymentSettings = psResult;
    // Bug 1 fix: do not write migration_logs on dry-run.
    if (!dryRun) {
      await this.safeLog({
        runId,
        scriptName: "customer-migration-payment-settings",
        monolithCustomerId,
        billingCustomerId: psResult.billingCustomerId ?? null,
        status: this.toLogStatus(psResult.status),
        errorMessage: psResult.status === "failed" ? psResult.reason : null,
        details: psResult as unknown as Record<string, unknown>,
      });
    }

    if (psResult.status === "failed" && !dryRun) {
      // Bug 3 fix: on dry-run, continue past a failed paymentSettings so the
      // operator sees the full six-step preview. On real-run, short-circuit
      // as before.
      return this.finishFailed(
        "paymentSettings",
        psResult,
        runId,
        stepResults,
        monolithCustomerId,
      );
    }

    // After step 1 succeeded or skipped (already_migrated), determine
    // billingCustomerId. For dry-run with skipped reason, we still use placeholder.
    // Bug 3 fix: when paymentSettings failed in dry-run, fall back to the
    // placeholder so subsequent writers still get called for the preview.
    const billingCustomerId =
      psResult.billingCustomerId ??
      (dryRun ? DRY_RUN_PLACEHOLDER_ID : undefined);

    if (!billingCustomerId) {
      // Shouldn't happen — failed path already returned above; skipped path has id.
      return this.finishFailed(
        "paymentSettings",
        { status: "failed", reason: "missing_billing_customer_id" },
        runId,
        stepResults,
        monolithCustomerId,
      );
    }

    // Steps 2-6 — run via runStep with short-circuit on failure (except for dry-run
    // which always runs all six writers in planning mode).
    const steps: Array<{
      name: StepName;
      run: () => Promise<StepResult>;
    }> = [
      {
        name: "creditBalance",
        run: () =>
          this.creditBalanceWriter.write(
            {
              billingCustomerId,
              latestPayroll: body.latestPayroll,
              stripeCustomerBalanceCents: body.stripeCustomerBalanceCents,
            },
            { dryRun, runId },
          ),
      },
      {
        name: "surcharge",
        run: () =>
          this.surchargeWriter.write(
            { billingCustomerId, surchargeConfig: body.surchargeConfig },
            { dryRun, runId },
          ),
      },
      {
        name: "payrolls",
        run: () =>
          this.payrollsWriter.write(
            { billingCustomerId, payrolls: body.payrolls },
            { dryRun, runId },
          ),
      },
      {
        name: "charges",
        run: () =>
          this.chargesWriter.write(
            { billingCustomerId, charges: body.charges },
            { dryRun, runId },
          ),
      },
      {
        name: "subscription",
        run: () =>
          this.subscriptionWriter.write(
            {
              billingCustomerId,
              paymentSettings: body.paymentSettings,
              latestPayroll: body.latestPayroll,
              // P13: pass body customer so dry-run preview uses real
              // chargeDay/isPrepaid instead of hardcoded defaults.
              customer: body.customer,
              // Round 2: monolith-sourced first-cycle dates. When present, writer skips
              // computeDueDate/computeBillingCycle; when absent, falls back unchanged.
              subscriptionTiming: body.subscriptionTiming ?? undefined,
            },
            { dryRun, runId },
          ),
      },
    ];

    // Bug 3 fix: track the first failure on dry-run, but continue the loop so
    // all six writer results are reported in stepResults. On real-run, keep
    // existing short-circuit-on-failure behaviour.
    // Bug 3 fix: if paymentSettings already failed in dry-run, capture it as
    // the first failure (it's already in stepResults).
    let firstFailedStep: StepName | undefined =
      dryRun && psResult.status === "failed" ? "paymentSettings" : undefined;
    let firstFailedResult: StepResult | undefined =
      dryRun && psResult.status === "failed" ? psResult : undefined;

    for (const step of steps) {
      let result: StepResult;
      try {
        result = await step.run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = {
          status: "failed",
          reason: "writer_threw",
          error: msg,
        };
      }
      stepResults[step.name] = result;
      // Bug 1 fix: do not write migration_logs on dry-run.
      if (!dryRun) {
        await this.safeLog({
          runId,
          scriptName: `customer-migration-${step.name}`,
          monolithCustomerId,
          billingCustomerId:
            billingCustomerId === DRY_RUN_PLACEHOLDER_ID
              ? null
              : billingCustomerId,
          status: this.toLogStatus(result.status),
          errorMessage: result.status === "failed" ? result.reason : null,
          details: result as unknown as Record<string, unknown>,
        });
      }

      if (result.status === "failed") {
        if (dryRun) {
          // Bug 3 fix: capture first failure, continue loop for full preview.
          if (!firstFailedStep) {
            firstFailedStep = step.name;
            firstFailedResult = result;
          }
          continue;
        }
        return this.finishFailed(
          step.name,
          result,
          runId,
          stepResults,
          monolithCustomerId,
          billingCustomerId === DRY_RUN_PLACEHOLDER_ID
            ? undefined
            : billingCustomerId,
        );
      }
    }

    // Bug 3 fix: dry-run final aggregation. If any writer failed, report
    // failed with the first failed step but include ALL six stepResults.
    if (dryRun && firstFailedStep && firstFailedResult) {
      const safeReason =
        firstFailedResult.status === "failed"
          ? firstFailedResult.reason
          : "unknown_failure";
      const safeError =
        firstFailedResult.status === "failed"
          ? firstFailedResult.error
          : undefined;
      return {
        status: "failed",
        runId,
        billingCustomerId: undefined,
        failedStep: firstFailedStep,
        error: safeError,
        reason: safeReason,
        stepResults,
      };
    }

    // Bug 1 fix: do not write migration_logs on dry-run.
    if (!dryRun) {
      await this.safeLog({
        runId,
        scriptName: "customer-migration-orchestrator",
        monolithCustomerId,
        billingCustomerId:
          billingCustomerId === DRY_RUN_PLACEHOLDER_ID
            ? null
            : billingCustomerId,
        status: "succeeded",
        details: { dryRun },
      });
    }

    return {
      status: "succeeded",
      billingCustomerId:
        billingCustomerId === DRY_RUN_PLACEHOLDER_ID
          ? undefined
          : billingCustomerId,
      runId,
      stepResults,
    };
  }

  private finishFailed(
    failedStep: StepName,
    result: StepResult,
    runId: string,
    stepResults: Partial<Record<StepName, StepResult>>,
    monolithCustomerId: string,
    billingCustomerId?: string,
  ): OrchestratorResult {
    const safeReason =
      result.status === "failed" ? result.reason : "unknown_failure";
    const safeError = result.status === "failed" ? result.error : undefined;

    void this.safeLog({
      runId,
      scriptName: "customer-migration-orchestrator",
      monolithCustomerId,
      billingCustomerId: billingCustomerId ?? null,
      status: "failed",
      errorMessage: safeReason,
      details: { failedStep, error: safeError },
    });

    return {
      status: "failed",
      runId,
      billingCustomerId,
      failedStep,
      error: safeError,
      reason: safeReason,
      stepResults,
    };
  }

  private toLogStatus(
    s: StepResult["status"],
  ): "succeeded" | "failed" | "skipped" {
    return s;
  }

  private async safeLog(
    params: Parameters<CustomerMigrationLogsRepository["writeStepLog"]>[0],
  ): Promise<void> {
    try {
      await this.logsRepository.writeStepLog(params);
    } catch (err) {
      this.logger.error({
        action: "customer-migration.log_write_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
