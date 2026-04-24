import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { CustomersService } from "../customers/customers.service";
import { SubscriptionsRepository } from "../subscriptions/subscriptions.repository";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicesRepository } from "../invoices/invoices.repository";
import { ChargesRepository } from "../charges/charges.repository";
import type { AdvanceCycleResponseDto } from "./dto/advance-cycle-response.dto";

@Injectable()
export class TimeMachineService {
  private readonly logger = new Logger(TimeMachineService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly customersService: CustomersService,
    private readonly subscriptionsRepository: SubscriptionsRepository,
    private readonly invoicesService: InvoicesService,
    private readonly invoicesRepository: InvoicesRepository,
    private readonly chargesRepository: ChargesRepository,
  ) {}

  async advanceCycle(
    monolithCustomerId: string,
  ): Promise<AdvanceCycleResponseDto> {
    this.assertNonProduction();

    const customer =
      await this.customersService.findByMonolithId(monolithCustomerId);
    if (!customer) {
      throw new NotFoundException(
        `No customer found with monolithCustomerId ${monolithCustomerId}`,
      );
    }

    const active = await this.subscriptionsRepository.findByCustomerAndStatuses(
      customer.id,
      ["active"],
    );
    if (active.length === 0) {
      const paused =
        await this.subscriptionsRepository.findByCustomerAndStatuses(
          customer.id,
          ["paused", "canceled"],
        );
      if (paused.length > 0) {
        throw new ConflictException(
          `Subscription is ${paused[0].status}; resume/activate it before running time machine`,
        );
      }
      throw new NotFoundException(
        `No active subscription found for customer ${customer.id}`,
      );
    }

    const subscription = active[0];
    const simulationId = `tm-${randomUUID()}`;
    const correlationId = simulationId;

    const beforeBillingPeriodStart = subscription.billingPeriodStart;
    const beforeBillingPeriodEnd = subscription.billingPeriodEnd;

    const beforeState = {
      billingPeriodStart: subscription.billingPeriodStart.toISOString(),
      billingPeriodEnd: subscription.billingPeriodEnd.toISOString(),
      nextBillingDate: subscription.nextBillingDate
        ? subscription.nextBillingDate.toISOString()
        : null,
    };

    this.logger.log({
      message: "Time machine advance starting",
      simulationId,
      monolithCustomerId,
      customerId: customer.id,
      subscriptionId: subscription.id,
      beforeState,
    });

    const now = new Date();
    await this.subscriptionsRepository.update(subscription.id, {
      nextBillingDate: now,
      updatedAt: now,
    });

    const generationResult =
      await this.invoicesService.generateInvoicesForDueSubscriptions(
        now.toISOString(),
        correlationId,
      );

    this.logger.log({
      message: "Time machine generator completed",
      simulationId,
      generationResult,
    });

    const latest = await this.subscriptionsRepository.findById(subscription.id);
    if (!latest) {
      throw new Error(
        `Subscription ${subscription.id} disappeared during advance cycle`,
      );
    }

    const advanceApplied =
      latest.billingPeriodStart.getTime() !==
      beforeBillingPeriodStart.getTime();

    const afterState = {
      billingPeriodStart: latest.billingPeriodStart.toISOString(),
      billingPeriodEnd: latest.billingPeriodEnd.toISOString(),
      nextBillingDate: latest.nextBillingDate
        ? latest.nextBillingDate.toISOString()
        : null,
      advanceApplied,
    };

    const generatedInvoices =
      await this.invoicesRepository.findDuplicateForSubscription(
        subscription.id,
        beforeBillingPeriodStart,
        beforeBillingPeriodEnd,
      );
    const cycleInvoice = generatedInvoices[0] ?? null;

    let invoiceSummary: AdvanceCycleResponseDto["invoice"] = null;
    if (cycleInvoice) {
      const charges = await this.chargesRepository.findByInvoiceId(
        cycleInvoice.id,
      );
      const latestCharge = charges[charges.length - 1] ?? null;
      const paymentStatus = this.mapPaymentStatus(
        cycleInvoice.status,
        latestCharge?.status,
      );
      invoiceSummary = {
        id: cycleInvoice.id,
        status: cycleInvoice.status,
        type: cycleInvoice.type,
        totalAmountCents: cycleInvoice.totalAmountCents,
        creditApplied:
          (cycleInvoice.metadata as { creditAdjustmentCents?: number } | null)
            ?.creditAdjustmentCents ?? 0,
        paymentStatus,
        stripePaymentIntentId: latestCharge?.stripePaymentIntentId ?? null,
      };
    }

    const notes: string[] = [];
    if (!cycleInvoice) {
      notes.push(
        "No invoice was produced. Either an invoice for this period already existed (duplicate) or the subscription was filtered out by findDueForBilling. Check BS logs with correlationId for details.",
      );
    }
    if (cycleInvoice && !advanceApplied) {
      notes.push(
        "Invoice generated but billing period not advanced. Likely async payment (ACH returned 'processing'); advance will apply when Stripe's payment_intent.succeeded webhook fires (~4-5 business days).",
      );
    }

    return {
      simulationId,
      customerId: customer.id,
      monolithCustomerId,
      subscriptionId: subscription.id,
      beforeState,
      invoice: invoiceSummary,
      afterState,
      notes,
    };
  }

  private assertNonProduction(): void {
    const env = this.configService.get<string>("app.nodeEnv");
    if (env === "production") {
      throw new ForbiddenException(
        "Time machine is disabled in production. This endpoint is only available in non-production environments.",
      );
    }
  }

  private mapPaymentStatus(
    invoiceStatus: string,
    chargeStatus: string | undefined,
  ): "succeeded" | "pending" | "failed" | "skipped" | "unknown" {
    if (invoiceStatus === "paid") return "succeeded";
    if (invoiceStatus === "void") return "skipped";
    if (chargeStatus === "failed") return "failed";
    if (chargeStatus === "pending" || invoiceStatus === "finalized")
      return "pending";
    if (!chargeStatus) return "skipped";
    return "unknown";
  }
}
