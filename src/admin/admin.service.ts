import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { CustomersRepository } from "../customers/customers.repository";
import { InvoicesRepository } from "../invoices/invoices.repository";
import { ChargesRepository } from "../charges/charges.repository";
import { DunningAttemptsRepository } from "../dunning/dunning.repository";
import { ReconciliationDiscrepanciesRepository } from "../reconciliation/reconciliation-discrepancies.repository";
import { RefundsRepository } from "../refunds/refunds.repository";
import { CreditNotesRepository } from "../credits/credit-notes.repository";
import { AuditTrailRepository } from "./audit-trail.repository";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import type { PaginatedResult } from "../common/dto/pagination.dto";
import type { CustomerSearchQueryDto } from "./dto/customer-search-query.dto";
import type { CustomerSearchResponseDto } from "./dto/customer-search-response.dto";
import type { PaymentHistoryQueryDto } from "./dto/payment-history-query.dto";
import type { PaymentHistoryResponseDto } from "./dto/payment-history-response.dto";
import type { InvoiceSearchQueryDto } from "./dto/invoice-search-query.dto";
import type { InvoiceSearchResponseDto } from "./dto/invoice-search-response.dto";
import type { InvoiceLineItemDetailResponseDto } from "./dto/invoice-line-item-detail-response.dto";
import type { DunningHistoryQueryDto } from "./dto/dunning-history-query.dto";
import type { DunningHistoryResponseDto } from "./dto/dunning-history-response.dto";
import type { DiscrepancySearchQueryDto } from "./dto/discrepancy-search-query.dto";
import type { DiscrepancySearchResponseDto } from "./dto/discrepancy-search-response.dto";
import type { UpdateDisputeStatusDto } from "./dto/update-dispute-status.dto";
import type { ResolveDiscrepancyDto } from "./dto/resolve-discrepancy.dto";
import type { ReconciliationExportQueryDto } from "./dto/reconciliation-export-query.dto";
import type { ReconciliationExportResponseDto } from "./dto/reconciliation-export-response.dto";
import { DISPUTE_STATUSES } from "./dto/dispute-status.constants";
import type { BillingHistoryQueryDto } from "./dto/billing-history-query.dto";
import type { BillingHistoryResponseDto } from "./dto/billing-history-response.dto";
import type { AuditTrailSearchQueryDto } from "./dto/audit-trail-search-query.dto";
import type { AuditTrailSearchResponseDto } from "./dto/audit-trail-search-response.dto";
import type { BulkSubscriptionOperationDto } from "./dto/bulk-subscription-operation.dto";
import type {
  BulkOperationResponseDto,
  BulkOperationResultDto,
} from "./dto/bulk-operation-response.dto";

@Injectable()
export class AdminService {
  constructor(
    private readonly customersRepository: CustomersRepository,
    private readonly invoicesRepository: InvoicesRepository,
    private readonly chargesRepository: ChargesRepository,
    private readonly dunningAttemptsRepository: DunningAttemptsRepository,
    private readonly discrepanciesRepository: ReconciliationDiscrepanciesRepository,
    private readonly refundsRepository: RefundsRepository,
    private readonly creditNotesRepository: CreditNotesRepository,
    private readonly auditTrailRepository: AuditTrailRepository,
    @Optional()
    private readonly subscriptionsService?: SubscriptionsService,
  ) {}

  async searchCustomers(
    query: CustomerSearchQueryDto,
  ): Promise<PaginatedResult<CustomerSearchResponseDto>> {
    const limit = query.limit ?? 20;

    const results = await this.customersRepository.search(
      {
        name: query.name,
        email: query.email,
        externalId: query.externalId,
        status: query.status,
        cursor: query.cursor,
      },
      limit,
    );

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const lastItem = data[data.length - 1];

    return {
      data: data.map((c) => ({
        id: c.id,
        monolithCustomerId: c.monolithCustomerId,
        name: c.name,
        email: c.email,
        status: c.status,
        stripeCustomerId: c.stripeCustomerId,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
      cursor: hasMore && lastItem ? lastItem.id : null,
      hasMore,
    };
  }

  async getPaymentHistory(
    customerId: string,
    query: PaymentHistoryQueryDto,
  ): Promise<PaginatedResult<PaymentHistoryResponseDto>> {
    const customer = await this.customersRepository.findById(customerId);

    if (!customer) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }

    const limit = query.limit ?? 20;

    const results =
      await this.chargesRepository.findByCustomerWithPaymentMethod(
        customerId,
        {
          dateFrom: query.dateFrom,
          dateTo: query.dateTo,
          cursor: query.cursor,
        },
        limit,
      );

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const lastItem = data[data.length - 1];

    return {
      data: data.map((r) => ({
        id: r.id,
        invoiceId: r.invoiceId,
        amountCents: r.amountCents,
        currency: r.currency,
        status: r.status,
        paymentMethodType: r.paymentMethodType,
        gatewayProvider: r.gatewayProvider,
        gatewayChargeId: r.stripePaymentIntentId,
        failureReason: r.failureReason,
        attemptNumber: r.attemptNumber,
        createdAt: r.createdAt.toISOString(),
      })),
      cursor: hasMore && lastItem ? lastItem.id : null,
      hasMore,
    };
  }

  async searchInvoices(
    query: InvoiceSearchQueryDto,
  ): Promise<PaginatedResult<InvoiceSearchResponseDto>> {
    const limit = query.limit ?? 20;

    const results = await this.invoicesRepository.searchForAdmin(
      {
        customerId: query.customerId,
        status: query.status,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        amountMin: query.amountMin,
        amountMax: query.amountMax,
        cursor: query.cursor,
      },
      limit,
    );

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const lastItem = data[data.length - 1];

    return {
      data: data.map((inv) => ({
        id: inv.id,
        customerId: inv.customerId,
        subscriptionId: inv.subscriptionId,
        status: inv.status,
        totalAmountCents: inv.totalAmountCents,
        currency: inv.currency,
        billingPeriodStart: inv.billingPeriodStart.toISOString(),
        billingPeriodEnd: inv.billingPeriodEnd.toISOString(),
        dueDate: inv.dueDate.toISOString(),
        paidAt: inv.paidAt?.toISOString() ?? null,
        voidedAt: inv.voidedAt?.toISOString() ?? null,
        createdAt: inv.createdAt.toISOString(),
        updatedAt: inv.updatedAt.toISOString(),
      })),
      cursor: hasMore && lastItem ? lastItem.id : null,
      hasMore,
    };
  }

  async getInvoiceLineItems(
    invoiceId: string,
  ): Promise<PaginatedResult<InvoiceLineItemDetailResponseDto>> {
    const invoice = await this.invoicesRepository.findById(invoiceId);

    if (!invoice) {
      throw new NotFoundException(`Invoice ${invoiceId} not found`);
    }

    const results =
      await this.invoicesRepository.getLineItemsByInvoiceId(invoiceId);

    return {
      data: results.map((li) => ({
        id: li.id,
        invoiceId: li.invoiceId,
        type: li.type,
        description: li.description,
        amountCents: li.amountCents,
        quantity: li.quantity,
        createdAt: li.createdAt.toISOString(),
      })),
      cursor: null,
      hasMore: false,
    };
  }

  async getDunningHistory(
    customerId: string,
    query: DunningHistoryQueryDto,
  ): Promise<PaginatedResult<DunningHistoryResponseDto>> {
    const customer = await this.customersRepository.findById(customerId);

    if (!customer) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }

    const limit = query.limit ?? 20;

    const results =
      await this.dunningAttemptsRepository.findWithInvoiceAndPaymentMethod(
        customerId,
        {
          dateFrom: query.dateFrom,
          dateTo: query.dateTo,
          cursor: query.cursor,
        },
        limit,
      );

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const lastItem = data[data.length - 1];

    return {
      data: data.map((da) => ({
        id: da.id,
        invoiceId: da.invoiceId,
        chargeId: da.chargeId,
        paymentMethodId: da.paymentMethodId,
        attemptNumber: da.attemptNumber,
        scheduledDate: da.scheduledDate.toISOString(),
        executedAt: da.executedAt?.toISOString() ?? null,
        status: da.status,
        failureReason: da.failureReason,
        paymentMethodType: da.paymentMethodType,
        gatewayProvider: da.gatewayProvider,
        createdAt: da.createdAt.toISOString(),
      })),
      cursor: hasMore && lastItem ? lastItem.id : null,
      hasMore,
    };
  }

  async searchDiscrepancies(
    query: DiscrepancySearchQueryDto,
  ): Promise<PaginatedResult<DiscrepancySearchResponseDto>> {
    const limit = query.limit ?? 20;

    const results = await this.discrepanciesRepository.search(
      {
        disputeStatus: query.disputeStatus,
        runId: query.runId,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        cursor: query.cursor,
      },
      limit,
    );

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const lastItem = data[data.length - 1];

    return {
      data: data.map((d) => ({
        id: d.id,
        reconciliationRunId: d.reconciliationRunId,
        type: d.type,
        internalReferenceId: d.internalReferenceId,
        stripeTransactionId: d.stripeTransactionId,
        expectedAmountCents: d.expectedAmountCents,
        actualAmountCents: d.actualAmountCents,
        differenceCents: d.differenceCents,
        disputeStatus: d.disputeStatus,
        resolvedBy: d.resolvedBy,
        resolutionNotes: d.resolutionNotes,
        resolvedAt: d.resolvedAt?.toISOString() ?? null,
        createdAt: d.createdAt.toISOString(),
        periodStart: d.periodStart?.toISOString() ?? null,
        periodEnd: d.periodEnd?.toISOString() ?? null,
      })),
      cursor: hasMore && lastItem ? lastItem.id : null,
      hasMore,
    };
  }

  async updateDisputeStatus(
    id: string,
    dto: UpdateDisputeStatusDto,
  ): Promise<DiscrepancySearchResponseDto> {
    const updated = await this.discrepanciesRepository.updateDisputeStatus(
      id,
      dto.status,
    );

    if (!updated) {
      throw new NotFoundException(`Discrepancy ${id} not found`);
    }

    const result = await this.discrepanciesRepository.findWithRunDetails(id);

    if (!result) {
      throw new NotFoundException(`Discrepancy ${id} not found after update`);
    }

    return {
      id: result.id,
      reconciliationRunId: result.reconciliationRunId,
      type: result.type,
      internalReferenceId: result.internalReferenceId,
      stripeTransactionId: result.stripeTransactionId,
      expectedAmountCents: result.expectedAmountCents,
      actualAmountCents: result.actualAmountCents,
      differenceCents: result.differenceCents,
      disputeStatus: result.disputeStatus,
      resolvedBy: result.resolvedBy,
      resolutionNotes: result.resolutionNotes,
      resolvedAt: result.resolvedAt?.toISOString() ?? null,
      createdAt: result.createdAt.toISOString(),
      periodStart: result.periodStart?.toISOString() ?? null,
      periodEnd: result.periodEnd?.toISOString() ?? null,
    };
  }

  async resolveDiscrepancy(
    id: string,
    dto: ResolveDiscrepancyDto,
    adminUserId: string,
  ): Promise<DiscrepancySearchResponseDto> {
    // Step 1: Fetch discrepancy to check current status
    const existing = await this.discrepanciesRepository.findById(id);

    if (!existing) {
      throw new NotFoundException(`Discrepancy ${id} not found`);
    }

    if (existing.disputeStatus === "resolved") {
      throw new ConflictException(`Discrepancy ${id} is already resolved`);
    }

    // Step 2: Atomic UPDATE with all 4 fields
    const updated = await this.discrepanciesRepository.resolve(id, {
      resolvedBy: adminUserId,
      resolutionNotes: dto.resolutionNotes,
    });

    if (!updated) {
      throw new NotFoundException(`Discrepancy ${id} not found`);
    }

    // Step 3: Follow-up SELECT+leftJoin for period hydration
    const result = await this.discrepanciesRepository.findWithRunDetails(id);

    if (!result) {
      throw new NotFoundException(`Discrepancy ${id} not found after update`);
    }

    return {
      id: result.id,
      reconciliationRunId: result.reconciliationRunId,
      type: result.type,
      internalReferenceId: result.internalReferenceId,
      stripeTransactionId: result.stripeTransactionId,
      expectedAmountCents: result.expectedAmountCents,
      actualAmountCents: result.actualAmountCents,
      differenceCents: result.differenceCents,
      disputeStatus: result.disputeStatus,
      resolvedBy: result.resolvedBy,
      resolutionNotes: result.resolutionNotes,
      resolvedAt: result.resolvedAt?.toISOString() ?? null,
      createdAt: result.createdAt.toISOString(),
      periodStart: result.periodStart?.toISOString() ?? null,
      periodEnd: result.periodEnd?.toISOString() ?? null,
    };
  }

  async exportReconciliationData(
    query: ReconciliationExportQueryDto,
  ): Promise<ReconciliationExportResponseDto> {
    const results = await this.discrepanciesRepository.exportByDateRange(
      query.dateFrom,
      query.dateTo,
    );

    const discrepancies: DiscrepancySearchResponseDto[] = results.map((d) => ({
      id: d.id,
      reconciliationRunId: d.reconciliationRunId,
      type: d.type,
      internalReferenceId: d.internalReferenceId,
      stripeTransactionId: d.stripeTransactionId,
      expectedAmountCents: d.expectedAmountCents,
      actualAmountCents: d.actualAmountCents,
      differenceCents: d.differenceCents,
      disputeStatus: d.disputeStatus,
      resolvedBy: d.resolvedBy,
      resolutionNotes: d.resolutionNotes,
      resolvedAt: d.resolvedAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
      periodStart: d.periodStart?.toISOString() ?? null,
      periodEnd: d.periodEnd?.toISOString() ?? null,
    }));

    const byStatus = DISPUTE_STATUSES.reduce(
      (acc, status) => {
        acc[status] = 0;
        return acc;
      },
      {} as Record<string, number>,
    );

    let totalDifferenceCents = 0;
    for (const d of discrepancies) {
      byStatus[d.disputeStatus] = (byStatus[d.disputeStatus] ?? 0) + 1;
      totalDifferenceCents += Math.abs(d.differenceCents);
    }

    return {
      exportDate: new Date().toISOString(),
      dateRange: {
        from: query.dateFrom,
        to: query.dateTo,
      },
      summary: {
        totalDiscrepancies: discrepancies.length,
        byStatus: byStatus as Record<(typeof DISPUTE_STATUSES)[number], number>,
        totalDifferenceCents,
      },
      discrepancies,
    };
  }

  async getBillingHistory(
    customerId: string,
    query: BillingHistoryQueryDto,
  ): Promise<PaginatedResult<BillingHistoryResponseDto>> {
    const customer = await this.customersRepository.findById(customerId);

    if (!customer) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }

    const limit = query.limit ?? 20;
    const cursorDate = query.cursor ? new Date(query.cursor) : undefined;
    const typeFilter = query.type ?? null;

    const allItems: BillingHistoryResponseDto[] = [];

    // Invoice query
    if (!typeFilter || typeFilter === "invoice") {
      const invoices = await this.invoicesRepository.findForBillingHistory(
        customerId,
        {
          startDate: query.dateFrom,
          endDate: query.dateTo,
          cursor: cursorDate,
        },
        limit,
      );

      for (const inv of invoices) {
        allItems.push({
          id: inv.id,
          type: "invoice",
          referenceId: inv.id,
          description: `Invoice for ${inv.billingPeriodStart.toISOString().split("T")[0]} - ${inv.billingPeriodEnd.toISOString().split("T")[0]}`,
          amountCents: inv.totalAmountCents,
          currency: inv.currency,
          status: inv.status,
          createdAt: inv.createdAt.toISOString(),
        });
      }
    }

    // Charges (payment) query
    if (!typeFilter || typeFilter === "payment") {
      const charges = await this.chargesRepository.findForBillingHistory(
        customerId,
        {
          startDate: query.dateFrom,
          endDate: query.dateTo,
          cursor: cursorDate,
        },
        limit,
      );

      for (const ch of charges) {
        const descText = ch.failureReason
          ? `Payment attempt #${ch.attemptNumber} - Failed: ${ch.failureReason}`
          : `Payment attempt #${ch.attemptNumber} - ${ch.status}`;
        allItems.push({
          id: ch.id,
          type: "payment",
          referenceId: ch.id,
          description: descText,
          amountCents: ch.amountCents,
          currency: ch.currency,
          status: ch.status,
          createdAt: ch.createdAt.toISOString(),
        });
      }
    }

    // Credit notes query
    if (!typeFilter || typeFilter === "credit") {
      const creditNotes =
        await this.creditNotesRepository.findForBillingHistory(
          customerId,
          {
            startDate: query.dateFrom,
            endDate: query.dateTo,
            cursor: cursorDate,
          },
          limit,
        );

      for (const cn of creditNotes) {
        allItems.push({
          id: cn.id,
          type: "credit",
          referenceId: cn.id,
          description: `Credit note: ${cn.reason}`,
          amountCents: cn.amountCents,
          currency: cn.currency,
          status: cn.status,
          createdAt: cn.createdAt.toISOString(),
        });
      }
    }

    // Refunds query
    if (!typeFilter || typeFilter === "refund") {
      const refunds = await this.refundsRepository.findForBillingHistory(
        customerId,
        {
          startDate: query.dateFrom,
          endDate: query.dateTo,
          cursor: cursorDate,
        },
        limit,
      );

      for (const ref of refunds) {
        const reasonText = ref.reason ?? "No reason provided";
        const failureSuffix = ref.failureReason
          ? ` - Failed: ${ref.failureReason}`
          : "";
        allItems.push({
          id: ref.id,
          type: "refund",
          referenceId: ref.id,
          description: `Refund: ${reasonText}${failureSuffix}`,
          amountCents: ref.amountCents,
          currency: ref.currency,
          status: ref.status,
          createdAt: ref.createdAt.toISOString(),
        });
      }
    }

    // Sort merged results by createdAt DESC
    allItems.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    // Apply pagination
    const hasMore = allItems.length > limit;
    const data = hasMore ? allItems.slice(0, limit) : allItems;
    const lastItem = data[data.length - 1];

    return {
      data,
      cursor: hasMore && lastItem ? lastItem.createdAt : null,
      hasMore,
    };
  }

  async searchAuditTrail(
    query: AuditTrailSearchQueryDto,
  ): Promise<PaginatedResult<AuditTrailSearchResponseDto>> {
    const limit = query.limit ?? 20;

    const results = await this.auditTrailRepository.search(
      {
        entityType: query.entityType,
        entityId: query.entityId,
        adminUserId: query.adminUserId,
        startDate: query.dateFrom,
        endDate: query.dateTo,
        cursor: query.cursor,
      },
      limit,
    );

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const lastItem = data[data.length - 1];

    return {
      data: data.map((r) => ({
        id: r.id,
        adminUserId: r.adminUserId,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        details: r.details,
        createdAt: r.createdAt.toISOString(),
      })),
      cursor: hasMore && lastItem ? lastItem.id : null,
      hasMore,
    };
  }

  async bulkSubscriptionOperation(
    dto: BulkSubscriptionOperationDto,
  ): Promise<BulkOperationResponseDto> {
    if (!this.subscriptionsService) {
      throw new InternalServerErrorException(
        "SubscriptionsService not available",
      );
    }

    const actionStatusMap = {
      pause: "paused",
      cancel: "canceled",
    } as const;

    const targetStatus = actionStatusMap[dto.action];
    const results: BulkOperationResultDto[] = [];

    for (const subscriptionId of dto.subscriptionIds) {
      try {
        await this.subscriptionsService.updateState(subscriptionId, {
          status: targetStatus,
        });
        results.push({ subscriptionId, success: true });
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        results.push({ subscriptionId, success: false, reason: message });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.length - successCount;

    return { successCount, failureCount, results };
  }
}
