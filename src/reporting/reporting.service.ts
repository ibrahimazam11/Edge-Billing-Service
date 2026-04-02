import { BadRequestException, Injectable } from "@nestjs/common";
import { SubscriptionsRepository } from "../subscriptions/subscriptions.repository";
import { LedgerEntriesRepository } from "../ledger/ledger-entries.repository";
import { ChargesRepository } from "../charges/charges.repository";
import { DunningAttemptsRepository } from "../dunning/dunning.repository";
import { ReconciliationRunsRepository } from "../reconciliation/reconciliation-runs.repository";
import { ReconciliationDiscrepanciesRepository } from "../reconciliation/reconciliation-discrepancies.repository";
import type { RevenueReportResponseDto } from "./dto/revenue-report-response.dto";
import type { ReconciliationQueryDto } from "./dto/reconciliation-query.dto";
import type { ReconciliationRunResponseDto } from "./dto/reconciliation-report-response.dto";
import type { PaginatedResult } from "../common/dto/pagination.dto";
import type { DunningReportResponseDto } from "./dto/dunning-report-response.dto";
import type { DashboardReportResponseDto } from "./dto/dashboard-report-response.dto";

@Injectable()
export class ReportingService {
  constructor(
    private readonly subscriptionsRepository: SubscriptionsRepository,
    private readonly ledgerEntriesRepository: LedgerEntriesRepository,
    private readonly chargesRepository: ChargesRepository,
    private readonly dunningAttemptsRepository: DunningAttemptsRepository,
    private readonly reconciliationRunsRepository: ReconciliationRunsRepository,
    private readonly discrepanciesRepository: ReconciliationDiscrepanciesRepository,
  ) {}

  async getRevenueReport(
    startDate: string,
    endDate: string,
  ): Promise<RevenueReportResponseDto> {
    if (new Date(startDate) >= new Date(endDate)) {
      throw new BadRequestException("startDate must be before endDate");
    }

    const revenue =
      await this.ledgerEntriesRepository.aggregateRevenueByDateRange(
        new Date(startDate),
        new Date(endDate),
      );

    const totalInvoiced = revenue.totalInvoiced;
    const totalCollected = revenue.totalCollected;
    const totalWriteOff = revenue.totalWriteOff;
    const totalCreditsIssued = revenue.totalCreditsIssued;

    return {
      totalInvoiced,
      totalCollected,
      totalOutstanding:
        totalInvoiced - totalCollected - totalWriteOff - totalCreditsIssued,
      totalWriteOff,
      totalCreditsIssued,
      netRevenue: totalCollected - totalWriteOff,
      currency: "usd",
      periodStart: startDate,
      periodEnd: endDate,
    };
  }

  async getReconciliationReport(
    query: ReconciliationQueryDto,
  ): Promise<PaginatedResult<ReconciliationRunResponseDto>> {
    if (
      query.startDate &&
      query.endDate &&
      new Date(query.startDate) >= new Date(query.endDate)
    ) {
      throw new BadRequestException("startDate must be before endDate");
    }

    const limit = query.limit ?? 20;

    const runs = await this.reconciliationRunsRepository.findByDateRange(
      {
        status: query.status,
        startDate: query.startDate,
        endDate: query.endDate,
        cursor: query.cursor,
      },
      limit,
    );

    const hasMore = runs.length > limit;
    const pageRuns = hasMore ? runs.slice(0, limit) : runs;

    // Batch-load discrepancies for all runs on this page
    let discrepancyMap = new Map<
      string,
      Array<{
        id: string;
        type: string;
        internalReferenceId: string | null;
        stripeTransactionId: string | null;
        expectedAmountCents: number;
        actualAmountCents: number;
        differenceCents: number;
      }>
    >();

    if (pageRuns.length > 0) {
      const runIds = pageRuns.map((r) => r.id);
      const discrepancies =
        await this.discrepanciesRepository.findByRunIds(runIds);

      discrepancyMap = new Map();
      for (const d of discrepancies) {
        const list = discrepancyMap.get(d.reconciliationRunId) ?? [];
        list.push({
          id: d.id,
          type: d.type,
          internalReferenceId: d.internalReferenceId,
          stripeTransactionId: d.stripeTransactionId,
          expectedAmountCents: d.expectedAmountCents,
          actualAmountCents: d.actualAmountCents,
          differenceCents: d.differenceCents,
        });
        discrepancyMap.set(d.reconciliationRunId, list);
      }
    }

    const data: ReconciliationRunResponseDto[] = pageRuns.map((run) => ({
      id: run.id,
      periodStart: run.periodStart.toISOString(),
      periodEnd: run.periodEnd.toISOString(),
      status: run.status,
      recordsCompared: run.recordsCompared,
      totalInternalAmountCents: run.totalInternalAmountCents,
      totalStripeAmountCents: run.totalStripeAmountCents,
      createdAt: run.createdAt.toISOString(),
      discrepancies: discrepancyMap.get(run.id) ?? [],
    }));

    const cursor =
      pageRuns.length > 0 ? pageRuns[pageRuns.length - 1].id : null;

    return {
      data,
      cursor: hasMore ? cursor : null,
      hasMore,
    };
  }

  private getCurrentMonthBoundaries(): {
    periodStart: string;
    periodEnd: string;
  } {
    const now = new Date();
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const startOfNextMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    return {
      periodStart: startOfMonth.toISOString(),
      periodEnd: startOfNextMonth.toISOString(),
    };
  }

  async getDunningReport(
    startDate?: string,
    endDate?: string,
  ): Promise<DunningReportResponseDto> {
    let periodStart: string;
    let periodEnd: string;

    if ((startDate && !endDate) || (!startDate && endDate)) {
      throw new BadRequestException(
        "Both startDate and endDate are required when either is provided",
      );
    }

    if (startDate && endDate) {
      if (new Date(startDate) >= new Date(endDate)) {
        throw new BadRequestException("startDate must be before endDate");
      }
      periodStart = startDate;
      periodEnd = endDate;
    } else {
      const bounds = this.getCurrentMonthBoundaries();
      periodStart = bounds.periodStart;
      periodEnd = bounds.periodEnd;
    }

    const mainResult =
      await this.dunningAttemptsRepository.aggregateDunningByDateRange(
        periodStart,
        periodEnd,
      );

    const escalatedResult =
      await this.dunningAttemptsRepository.aggregateEscalatedByDateRange(
        periodStart,
        periodEnd,
      );

    const recoveryByAttempt =
      await this.dunningAttemptsRepository.aggregateRecoveryByAttempt(
        periodStart,
        periodEnd,
      );

    const totalInvoicesInDunning = mainResult.totalInvoicesInDunning;
    const recoveredCount = mainResult.recoveredCount;
    const recoveredAmountCents = mainResult.recoveredAmountCents;
    const avgRecoveryAttempts = mainResult.avgRecoveryAttempts;

    const escalatedCount = escalatedResult.escalatedCount;
    const escalatedAmountCents = escalatedResult.escalatedAmountCents;

    const recoveryRate =
      totalInvoicesInDunning > 0
        ? Number(((recoveredCount / totalInvoicesInDunning) * 100).toFixed(2))
        : 0;

    return {
      totalInvoicesInDunning,
      totalRecovered: {
        count: recoveredCount,
        amountCents: recoveredAmountCents,
      },
      totalEscalated: {
        count: escalatedCount,
        amountCents: escalatedAmountCents,
      },
      recoveryRate,
      averageRecoveryAttempts: Number(avgRecoveryAttempts.toFixed(2)),
      recoveryByAttempt,
      periodStart,
      periodEnd,
    };
  }

  async getDashboardReport(): Promise<DashboardReportResponseDto> {
    const { periodStart, periodEnd } = this.getCurrentMonthBoundaries();

    const subMetrics = await this.subscriptionsRepository.getActiveMetrics();

    const revenue =
      await this.ledgerEntriesRepository.aggregateRevenueByDateRange(
        new Date(periodStart),
        new Date(periodEnd),
      );

    const chargeMetrics =
      await this.chargesRepository.aggregateSuccessRateByDateRange(
        periodStart,
        periodEnd,
      );

    const dunningStats =
      await this.dunningAttemptsRepository.aggregateDunningStats(
        periodStart,
        periodEnd,
      );

    const latestReconStatus =
      await this.reconciliationRunsRepository.getLatestRunStatus();

    const activeSubscriptions = subMetrics.activeCount;
    const monthlyRecurringRevenue = subMetrics.mrr;

    const currentMonthInvoiced = revenue.totalInvoiced;
    const currentMonthCollected = revenue.totalCollected;
    const currentMonthWriteOff = revenue.totalWriteOff;
    const currentMonthCredits = revenue.totalCreditsIssued;
    const currentMonthOutstanding =
      currentMonthInvoiced -
      currentMonthCollected -
      currentMonthWriteOff -
      currentMonthCredits;

    const totalCharges = chargeMetrics.totalCharges;
    const succeededCharges = chargeMetrics.succeededCharges;
    const paymentSuccessRate =
      totalCharges > 0
        ? Number(((succeededCharges / totalCharges) * 100).toFixed(2))
        : 0;

    const totalDunning = dunningStats.totalDunning;
    const recoveredDunning = dunningStats.recovered;
    const dunningRecoveryRate =
      totalDunning > 0
        ? Number(((recoveredDunning / totalDunning) * 100).toFixed(2))
        : 0;

    const reconciliationStatus: DashboardReportResponseDto["reconciliationStatus"] =
      latestReconStatus !== null
        ? (latestReconStatus as DashboardReportResponseDto["reconciliationStatus"])
        : "none";

    return {
      activeSubscriptions,
      monthlyRecurringRevenue,
      currentMonthInvoiced,
      currentMonthCollected,
      currentMonthOutstanding,
      paymentSuccessRate,
      dunningRecoveryRate,
      reconciliationStatus,
      currency: "usd",
      periodStart,
      periodEnd,
    };
  }
}
