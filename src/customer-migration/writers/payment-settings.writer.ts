import { Inject, Injectable, Logger } from "@nestjs/common";
import { DRIZZLE_PROVIDER } from "../../database/database.provider";
import type { DrizzleDatabase } from "../../database/types";
import { customers } from "../../database/schema/customers";
import { paymentMethods } from "../../database/schema/payment-methods";
import { gatewayAssignments } from "../../database/schema/gateway-assignments";
import { generateId } from "../../common/utils/uuid.util";
import { CustomersRepository } from "../../customers/customers.repository";
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from "../../gateway/gateway.interface";
import { DRY_RUN_PLACEHOLDER_ID, type StepResult } from "../helpers";
import type {
  CustomerInputDto,
  PaymentSettingsInputDto,
} from "../dto/migrate-customer-body.dto";

export interface PaymentSettingsWriteInput {
  customer: CustomerInputDto;
  paymentSettings: PaymentSettingsInputDto;
}

export type PaymentSettingsWriteOutput = StepResult & {
  billingCustomerId?: string;
};

function mapPmType(stripeType: string): string {
  switch (stripeType.toLowerCase()) {
    case "card":
      return "card";
    case "us_bank_account":
    case "bank_account":
      return "bank_account";
    default:
      return stripeType.toLowerCase();
  }
}

@Injectable()
export class PaymentSettingsWriter {
  private readonly logger = new Logger(PaymentSettingsWriter.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly customersRepository: CustomersRepository,
  ) {}

  async write(
    input: PaymentSettingsWriteInput,
    opts: { dryRun: boolean; runId: string },
  ): Promise<PaymentSettingsWriteOutput> {
    const { customer, paymentSettings } = input;

    // CHEQUE rejection (frozen Never)
    if (paymentSettings.paymentMethodType === "CHEQUE") {
      return {
        status: "failed",
        reason: "payment_method_type_unsupported",
      };
    }

    // Idempotency
    const existing = await this.customersRepository.findByMonolithId(
      customer.monolithCustomerId,
    );
    if (existing) {
      return {
        status: "skipped",
        reason: "already_migrated",
        billingCustomerId: existing.id,
      };
    }

    let stripeCustomer;
    let stripePms;
    try {
      stripeCustomer = await this.gateway.getCustomer(
        paymentSettings.stripeCustomerId,
      );
      stripePms = await this.gateway.listPaymentMethods(
        paymentSettings.stripeCustomerId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({
        action: "customer-migration.payment-settings.stripe_fetch_failed",
        monolithCustomerId: customer.monolithCustomerId,
        error: msg,
      });
      return {
        status: "failed",
        reason: "stripe_customer_unreachable",
        error: msg,
      };
    }

    const defaultPmId = stripeCustomer.defaultPaymentMethodId;

    if (opts.dryRun) {
      return {
        status: "succeeded",
        dryRun: true,
        billingCustomerId: DRY_RUN_PLACEHOLDER_ID,
        planned: {
          customer: {
            monolithCustomerId: customer.monolithCustomerId,
            companyName: customer.companyName,
            contactEmail: customer.contactEmail,
            chargeDay: customer.trialEndDate,
            isPrepaid: customer.isPrepaid,
          },
          paymentMethodCount: stripePms.length,
          defaultPaymentMethodId: defaultPmId,
          gatewayAssignment: {
            gatewayProvider: "stripe",
            gatewayCustomerId: paymentSettings.stripeCustomerId,
          },
        },
      };
    }

    const billingCustomerId = generateId();
    const now = new Date();

    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(customers).values({
          id: billingCustomerId,
          monolithCustomerId: customer.monolithCustomerId,
          stripeCustomerId: paymentSettings.stripeCustomerId,
          name: customer.companyName,
          email: customer.contactEmail,
          status: "active",
          chargeDay: customer.trialEndDate,
          isPrepaid: customer.isPrepaid,
          metadata: {
            monolith_subscription_id: paymentSettings.subscriptionId ?? null,
            monolith_subscription_item_id:
              paymentSettings.subscriptionItemId ?? null,
            monolith_status: customer.status,
          },
          createdAt: now,
          updatedAt: now,
        });

        for (const pm of stripePms) {
          const mappedType = mapPmType(pm.type);
          const isDefault = pm.id === defaultPmId;

          // P1: Mandate is persisted ONLY when paymentMethodType === 'ACH'
          // (regardless of whether the default PM type happens to be bank_account).
          const persistMandate =
            isDefault &&
            paymentSettings.paymentMethodType === "ACH" &&
            !!paymentSettings.mandateId;

          await tx.insert(paymentMethods).values({
            id: generateId(),
            customerId: billingCustomerId,
            stripePaymentMethodId: pm.id,
            type: mappedType,
            isDefault,
            lastFour: pm.last4,
            brand: pm.brand,
            bankName: pm.bankName,
            expiryMonth: pm.expiryMonth,
            expiryYear: pm.expiryYear,
            metadata: persistMandate
              ? { mandate_id: paymentSettings.mandateId }
              : null,
            status: "active",
            createdAt: now,
            updatedAt: now,
          });
        }

        await tx.insert(gatewayAssignments).values({
          id: generateId(),
          customerId: billingCustomerId,
          gatewayProvider: "stripe",
          gatewayCustomerId: paymentSettings.stripeCustomerId,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({
        action: "customer-migration.payment-settings.tx_failed",
        monolithCustomerId: customer.monolithCustomerId,
        error: msg,
      });
      return { status: "failed", reason: "tx_failed", error: msg };
    }

    return {
      status: "succeeded",
      billingCustomerId,
      data: {
        paymentMethodCount: stripePms.length,
        defaultPaymentMethodId: defaultPmId,
      },
    };
  }
}
