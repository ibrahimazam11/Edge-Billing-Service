import { Injectable, Inject, Logger } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from "../gateway/gateway.interface";
import type { BalanceTransactionResult } from "../gateway/gateway.types";
import { ChargesRepository } from "../charges/charges.repository";
import { ReconciliationDiscrepanciesRepository } from "./reconciliation-discrepancies.repository";
import { ReconciliationRunsRepository } from "./reconciliation-runs.repository";
import { LedgerEntriesRepository } from "../ledger/ledger-entries.repository";

export interface ReconciliationRun {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  status: "balanced" | "discrepancy_found" | "failed";
  recordsCompared: number;
  totalInternalAmountCents: number;
  totalStripeAmountCents: number;
  errorReason: string | null;
  discrepancies: Discrepancy[];
}

export interface Discrepancy {
  type: "missing_internal" | "missing_stripe" | "amount_mismatch";
  internalReferenceId: string | null;
  stripeTransactionId: string | null;
  expectedAmountCents: number;
  actualAmountCents: number;
  differenceCents: number;
}

interface InternalPaymentRecord {
  chargeId: string;
  stripePaymentIntentId: string;
  amountCents: number;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER)
    private readonly db: DrizzleDatabase,
    @Inject(PAYMENT_GATEWAY)
    private readonly gateway: PaymentGateway,
    private readonly chargesRepository: ChargesRepository,
    private readonly discrepanciesRepository: ReconciliationDiscrepanciesRepository,
    private readonly reconciliationRunsRepo: ReconciliationRunsRepository,
    private readonly ledgerEntriesRepo: LedgerEntriesRepository,
  ) {}

  async runDailyReconciliation(
    periodStart: Date,
    periodEnd: Date,
    correlationId: string,
  ): Promise<ReconciliationRun> {
    // AC5: Duplicate run prevention
    const existingRun = await this.reconciliationRunsRepo.findExistingRun(
      periodStart,
      periodEnd,
    );
    if (existingRun) {
      this.logger.debug({
        message: "Reconciliation already completed for period, skipping",
        period: {
          start: periodStart.toISOString(),
          end: periodEnd.toISOString(),
        },
        existingRunId: existingRun.id,
        correlationId,
      });
      return {
        id: existingRun.id,
        periodStart,
        periodEnd,
        status: existingRun.status,
        recordsCompared: existingRun.recordsCompared,
        totalInternalAmountCents: existingRun.totalInternalAmountCents,
        totalStripeAmountCents: existingRun.totalStripeAmountCents,
        errorReason: existingRun.errorReason,
        discrepancies: [],
      };
    }

    // AC4: Error handling — catch gateway errors
    let stripeTransactions: BalanceTransactionResult[];
    try {
      stripeTransactions = await this.getStripeSettlements(
        periodStart,
        periodEnd,
      );
    } catch (error) {
      const errorReason =
        error instanceof Error ? error.message : String(error);
      this.logger.error({
        message: "Reconciliation failed — Stripe API error",
        period: {
          start: periodStart.toISOString(),
          end: periodEnd.toISOString(),
        },
        error: errorReason,
        correlationId,
      });
      return this.storeFailedRun(
        periodStart,
        periodEnd,
        correlationId,
        errorReason,
      );
    }

    // AC1: Get internal payment records
    const internalPayments = await this.getInternalPayments(
      periodStart,
      periodEnd,
    );

    // AC1, AC3: Compare records
    const {
      discrepancies,
      totalInternalAmountCents,
      totalStripeAmountCents,
      recordsCompared,
    } = this.compareRecords(internalPayments, stripeTransactions);
    const status =
      discrepancies.length === 0 ? "balanced" : "discrepancy_found";

    // Store result
    const run = await this.storeResult(
      periodStart,
      periodEnd,
      correlationId,
      status,
      recordsCompared,
      totalInternalAmountCents,
      totalStripeAmountCents,
      discrepancies,
    );

    // AC2, AC3: Structured logging
    if (status === "balanced") {
      this.logger.log({
        message: "Reconciliation completed — balanced",
        period: {
          start: periodStart.toISOString(),
          end: periodEnd.toISOString(),
        },
        recordsCompared,
        totalAmount: totalInternalAmountCents,
        status: "balanced",
        correlationId,
      });
    } else {
      this.logger.error({
        message: "Reconciliation completed — discrepancies found",
        period: {
          start: periodStart.toISOString(),
          end: periodEnd.toISOString(),
        },
        discrepancyCount: discrepancies.length,
        totalDiscrepancyAmount: discrepancies.reduce(
          (sum, d) => sum + Math.abs(d.differenceCents),
          0,
        ),
        status: "discrepancy_found",
        correlationId,
      });
    }

    return run;
  }

  private async getInternalPayments(
    periodStart: Date,
    periodEnd: Date,
  ): Promise<InternalPaymentRecord[]> {
    // Query ledger entries where reference_type='payment' and join with charges
    // to get stripe_payment_intent_id
    const entries = await this.ledgerEntriesRepo.findByReferenceType(
      "payment",
      { start: periodStart, end: periodEnd },
    );

    if (entries.length === 0) {
      return [];
    }

    // Batch-load charges to get stripe_payment_intent_id (avoid N+1)
    const chargeIds = entries.map((e) => e.referenceId);
    const chargeRecords = await this.chargesRepository.findByIds(chargeIds);

    const chargeMap = new Map(
      chargeRecords
        .filter((c) => c.stripePaymentIntentId != null)
        .map((c) => [c.id, c]),
    );

    return entries
      .filter((e) => chargeMap.has(e.referenceId))
      .map((e) => {
        const charge = chargeMap.get(e.referenceId)!;
        return {
          chargeId: charge.id,
          stripePaymentIntentId: charge.stripePaymentIntentId!,
          amountCents: charge.amountCents,
        };
      });
  }

  private async getStripeSettlements(
    periodStart: Date,
    periodEnd: Date,
  ): Promise<BalanceTransactionResult[]> {
    const createdGte = Math.floor(periodStart.getTime() / 1000);
    const createdLt = Math.floor(periodEnd.getTime() / 1000);

    const allTransactions = await this.gateway.getBalanceTransactions({
      createdGte,
      createdLt,
      limit: 100,
    });

    // Filter to charge type only (exclude payouts, refunds, adjustments)
    return allTransactions.filter((t) => t.type === "charge");
  }

  private compareRecords(
    internalPayments: InternalPaymentRecord[],
    stripeTransactions: BalanceTransactionResult[],
  ): {
    discrepancies: Discrepancy[];
    totalInternalAmountCents: number;
    totalStripeAmountCents: number;
    recordsCompared: number;
  } {
    const discrepancies: Discrepancy[] = [];

    // Build maps keyed by PaymentIntent ID
    const internalMap = new Map<string, InternalPaymentRecord>();
    for (const payment of internalPayments) {
      if (internalMap.has(payment.stripePaymentIntentId)) {
        this.logger.warn({
          message:
            "Duplicate PaymentIntent ID in internal payments — last entry wins",
          stripePaymentIntentId: payment.stripePaymentIntentId,
          chargeId: payment.chargeId,
        });
      }
      internalMap.set(payment.stripePaymentIntentId, payment);
    }

    const stripeMap = new Map<string, BalanceTransactionResult>();
    for (const txn of stripeTransactions) {
      if (txn.source) {
        stripeMap.set(txn.source, txn);
      }
    }

    // Check for missing_stripe and amount_mismatch
    for (const [piId, internal] of internalMap) {
      const stripeTxn = stripeMap.get(piId);
      if (!stripeTxn) {
        discrepancies.push({
          type: "missing_stripe",
          internalReferenceId: internal.chargeId,
          stripeTransactionId: null,
          expectedAmountCents: internal.amountCents,
          actualAmountCents: 0,
          differenceCents: internal.amountCents,
        });
      } else if (internal.amountCents !== stripeTxn.amount) {
        discrepancies.push({
          type: "amount_mismatch",
          internalReferenceId: internal.chargeId,
          stripeTransactionId: stripeTxn.id,
          expectedAmountCents: internal.amountCents,
          actualAmountCents: stripeTxn.amount,
          differenceCents: internal.amountCents - stripeTxn.amount,
        });
      }
    }

    // Check for missing_internal
    for (const [piId, stripeTxn] of stripeMap) {
      if (!internalMap.has(piId)) {
        discrepancies.push({
          type: "missing_internal",
          internalReferenceId: null,
          stripeTransactionId: stripeTxn.id,
          expectedAmountCents: 0,
          actualAmountCents: stripeTxn.amount,
          differenceCents: -stripeTxn.amount,
        });
      }
    }

    const totalInternalAmountCents = internalPayments.reduce(
      (sum, p) => sum + p.amountCents,
      0,
    );
    const totalStripeAmountCents = stripeTransactions.reduce(
      (sum, t) => sum + t.amount,
      0,
    );

    // Count unique records examined across both systems
    const allKeys = new Set([...internalMap.keys(), ...stripeMap.keys()]);
    const recordsCompared = allKeys.size;

    return {
      discrepancies,
      totalInternalAmountCents,
      totalStripeAmountCents,
      recordsCompared,
    };
  }

  private async storeResult(
    periodStart: Date,
    periodEnd: Date,
    correlationId: string,
    status: "balanced" | "discrepancy_found",
    recordsCompared: number,
    totalInternalAmountCents: number,
    totalStripeAmountCents: number,
    discrepancies: Discrepancy[],
  ): Promise<ReconciliationRun> {
    const runId = uuidv7();

    await this.db.transaction(async (tx) => {
      await this.reconciliationRunsRepo.createInTx(
        {
          id: runId,
          periodStart,
          periodEnd,
          status,
          recordsCompared,
          totalInternalAmountCents,
          totalStripeAmountCents,
          errorReason: null,
          correlationId,
        },
        tx,
      );

      if (discrepancies.length > 0) {
        await this.discrepanciesRepository.insertBatch(
          discrepancies.map((d) => ({
            id: uuidv7(),
            reconciliationRunId: runId,
            type: d.type,
            internalReferenceId: d.internalReferenceId,
            stripeTransactionId: d.stripeTransactionId,
            expectedAmountCents: d.expectedAmountCents,
            actualAmountCents: d.actualAmountCents,
            differenceCents: d.differenceCents,
          })),
          tx,
        );
      }
    });

    return {
      id: runId,
      periodStart,
      periodEnd,
      status,
      recordsCompared,
      totalInternalAmountCents,
      totalStripeAmountCents,
      errorReason: null,
      discrepancies,
    };
  }

  private async storeFailedRun(
    periodStart: Date,
    periodEnd: Date,
    correlationId: string,
    errorReason: string,
  ): Promise<ReconciliationRun> {
    const runId = uuidv7();

    await this.reconciliationRunsRepo.createFailed({
      id: runId,
      periodStart,
      periodEnd,
      status: "failed",
      recordsCompared: 0,
      totalInternalAmountCents: 0,
      totalStripeAmountCents: 0,
      errorReason,
      correlationId,
    });

    return {
      id: runId,
      periodStart,
      periodEnd,
      status: "failed",
      recordsCompared: 0,
      totalInternalAmountCents: 0,
      totalStripeAmountCents: 0,
      errorReason,
      discrepancies: [],
    };
  }
}
