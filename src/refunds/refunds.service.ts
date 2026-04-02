import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { GatewayRegistry } from "../gateway/gateway.registry";
import { GatewayProvider } from "../common/enums/gateway-provider.enum";
import { LedgerService } from "../ledger/ledger.service";
import { SqsProducerService } from "../integration/sqs/sqs-producer.service";
import { RefundsRepository } from "./refunds.repository";
import { ChargesRepository } from "../charges/charges.repository";
import { PaymentMethodsRepository } from "../payment-methods/payment-methods.repository";
import { generateId } from "../common/utils/uuid.util";
import { validateTransition } from "../common/utils/state-machine.util";
import { REFUND_TRANSITIONS, type RefundStatus } from "./refund-state-machine";
import { validateRefundAmount } from "./validate-refund-amount";
import { BusinessRuleViolationException } from "../common/exceptions/billing.exception";
import type { CreateRefundInput } from "./dto/create-refund.dto";
import type { RefundResponseDto } from "./dto/refund-response.dto";
import { refunds } from "../database/schema/refunds";

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    private readonly refundsRepository: RefundsRepository,
    private readonly chargesRepository: ChargesRepository,
    private readonly paymentMethodsRepository: PaymentMethodsRepository,
    private readonly gatewayRegistry: GatewayRegistry,
    private readonly ledgerService: LedgerService,
    @Optional() private readonly sqsProducerService?: SqsProducerService,
  ) {}

  async createRefund(
    dto: CreateRefundInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<RefundResponseDto> {
    // 1. Validate charge
    const charge = await this.chargesRepository.findById(dto.chargeId);

    if (!charge) {
      throw new NotFoundException(`Charge ${dto.chargeId} not found`);
    }

    // Cross-resource ownership validation
    if (dto.customerId && charge.customerId !== dto.customerId) {
      throw new NotFoundException(`Charge ${dto.chargeId} not found`);
    }

    // Charge must be in succeeded status
    if (charge.status !== "succeeded") {
      throw new BusinessRuleViolationException(
        `Charge ${dto.chargeId} must be in succeeded status, current: ${charge.status}`,
      );
    }

    // Charge must have a gateway reference
    if (!charge.stripePaymentIntentId) {
      throw new BusinessRuleViolationException(
        `Charge ${dto.chargeId} has no gateway payment reference`,
      );
    }

    // Load payment method to resolve gateway provider
    const pm = await this.paymentMethodsRepository.findById(
      charge.paymentMethodId,
    );

    const pmGatewayProvider = (pm?.gatewayProvider ??
      GatewayProvider.Stripe) as GatewayProvider;

    // 2. Validate refund amount
    const existingRefunds =
      await this.refundsRepository.findSucceededByChargeId(dto.chargeId);

    const existingTotalCents = existingRefunds.reduce(
      (sum, r) => sum + r.amountCents,
      0,
    );

    validateRefundAmount(
      charge.amountCents,
      existingTotalCents,
      dto.amountCents,
    );

    // 3. Insert refund (pending) — idempotency handled by repository
    const refundId = generateId();
    const now = new Date();

    const { refund: createdRefund, isDuplicate } =
      await this.refundsRepository.createWithIdempotency({
        id: refundId,
        chargeId: charge.id,
        invoiceId: charge.invoiceId,
        customerId: charge.customerId,
        amountCents: dto.amountCents,
        currency: charge.currency,
        status: "pending",
        reason: dto.reason,
        idempotencyKey,
        createdAt: now,
        updatedAt: now,
      });

    if (isDuplicate) {
      this.logger.log({
        message: "Duplicate refund detected via idempotency key",
        idempotencyKey,
        chargeId: dto.chargeId,
        correlationId,
      });
      return this.toResponseDto(createdRefund);
    }

    // 4. Transition to processing
    validateTransition(
      "pending" as RefundStatus,
      "processing" as RefundStatus,
      REFUND_TRANSITIONS,
    );

    await this.refundsRepository.updateStatus(refundId, {
      status: "processing",
      updatedAt: new Date(),
    });

    // 5. Call gateway
    try {
      const gateway = this.gatewayRegistry.getAdapter(pmGatewayProvider);
      const gatewayResult = await gateway.createRefund({
        chargeId: charge.stripePaymentIntentId,
        amount: dto.amountCents,
        reason: dto.reason,
        idempotencyKey,
      });

      // 6a. SUCCESS: transaction { update refund to succeeded + ledger entry }
      validateTransition(
        "processing" as RefundStatus,
        "succeeded" as RefundStatus,
        REFUND_TRANSITIONS,
      );

      const succeededAt = new Date();

      await this.db.transaction(async (tx) => {
        await this.refundsRepository.updateToSucceeded(
          refundId,
          gatewayResult.id,
          tx,
        );

        await this.ledgerService.recordRefundSucceeded(
          refundId,
          dto.amountCents,
          charge.currency,
          correlationId,
          tx,
        );
      });

      this.logger.log({
        message: "Refund succeeded",
        refundId,
        chargeId: dto.chargeId,
        gatewayRefundId: gatewayResult.id,
        amountCents: dto.amountCents,
        correlationId,
      });

      if (this.sqsProducerService) {
        void this.sqsProducerService
          .publish(
            "refund.succeeded",
            {
              refundId,
              chargeId: charge.id,
              invoiceId: charge.invoiceId,
              customerId: charge.customerId,
              amount: dto.amountCents,
              currency: charge.currency,
              reason: dto.reason,
              gatewayProvider: pmGatewayProvider,
            },
            correlationId,
          )
          .catch((err: unknown) => {
            this.logger.warn({
              message: "Failed to publish refund.succeeded event",
              refundId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      return this.toResponseDto({
        id: refundId,
        chargeId: charge.id,
        invoiceId: charge.invoiceId,
        customerId: charge.customerId,
        amountCents: dto.amountCents,
        currency: charge.currency,
        status: "succeeded",
        reason: dto.reason,
        idempotencyKey,
        gatewayRefundId: gatewayResult.id,
        failureReason: null,
        createdAt: now,
        updatedAt: succeededAt,
      });
    } catch (error: unknown) {
      // 6b. FAILURE: update refund to failed + failureReason
      const failureReason =
        error instanceof Error ? error.message : String(error);

      validateTransition(
        "processing" as RefundStatus,
        "failed" as RefundStatus,
        REFUND_TRANSITIONS,
      );

      const failedAt = new Date();

      await this.refundsRepository.updateStatus(refundId, {
        status: "failed",
        failureReason,
        updatedAt: failedAt,
      });

      this.logger.warn({
        message: "Refund failed",
        refundId,
        chargeId: dto.chargeId,
        failureReason,
        correlationId,
      });

      if (this.sqsProducerService) {
        void this.sqsProducerService
          .publish(
            "refund.failed",
            {
              refundId,
              chargeId: charge.id,
              invoiceId: charge.invoiceId,
              customerId: charge.customerId,
              amount: dto.amountCents,
              currency: charge.currency,
              reason: dto.reason,
              gatewayProvider: pmGatewayProvider,
              failureReason,
            },
            correlationId,
          )
          .catch((err: unknown) => {
            this.logger.warn({
              message: "Failed to publish refund.failed event",
              refundId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      return this.toResponseDto({
        id: refundId,
        chargeId: charge.id,
        invoiceId: charge.invoiceId,
        customerId: charge.customerId,
        amountCents: dto.amountCents,
        currency: charge.currency,
        status: "failed",
        reason: dto.reason,
        idempotencyKey,
        gatewayRefundId: null,
        failureReason,
        createdAt: now,
        updatedAt: failedAt,
      });
    }
  }

  async findById(refundId: string): Promise<RefundResponseDto | null> {
    const refund = await this.refundsRepository.findById(refundId);

    if (!refund) {
      return null;
    }

    return this.toResponseDto(refund);
  }

  private toResponseDto(
    refund: typeof refunds.$inferSelect,
  ): RefundResponseDto {
    return {
      id: refund.id,
      chargeId: refund.chargeId,
      invoiceId: refund.invoiceId,
      customerId: refund.customerId,
      amountCents: refund.amountCents,
      currency: refund.currency,
      status: refund.status,
      reason: refund.reason,
      idempotencyKey: refund.idempotencyKey,
      gatewayRefundId: refund.gatewayRefundId,
      failureReason: refund.failureReason,
      createdAt: refund.createdAt.toISOString(),
      updatedAt: refund.updatedAt.toISOString(),
    };
  }
}
