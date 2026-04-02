import { Injectable, Logger } from "@nestjs/common";
import { SurchargeConfigRepository } from "./surcharge-config.repository";
import type { UpsertSurchargeConfigDto } from "./dto/upsert-surcharge-config.dto";

export interface SurchargeConfig {
  id: string;
  customerId: string;
  allowCreditCard: boolean;
  surchargeType: "percentage" | "flat_fee" | null;
  surchargeValue: number | null;
  reason: string | null;
  notes: string | null;
  enabledBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class SurchargeConfigService {
  private readonly logger = new Logger(SurchargeConfigService.name);

  constructor(
    private readonly surchargeConfigRepo: SurchargeConfigRepository,
  ) {}

  async getConfig(customerId: string): Promise<SurchargeConfig | null> {
    const config = await this.surchargeConfigRepo.findByCustomer(customerId);

    if (!config) {
      return null;
    }

    return {
      id: config.id,
      customerId: config.customerId,
      allowCreditCard: config.allowCreditCard,
      surchargeType: config.surchargeType,
      surchargeValue: config.surchargeValue,
      reason: config.reason,
      notes: config.notes,
      enabledBy: config.enabledBy,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }

  async upsertConfig(
    customerId: string,
    dto: UpsertSurchargeConfigDto,
  ): Promise<SurchargeConfig> {
    const result = await this.surchargeConfigRepo.upsert(customerId, {
      allowCreditCard: dto.allowCreditCard,
      surchargeType: dto.surchargeType,
      surchargeValue: dto.surchargeValue,
      reason: dto.reason,
      notes: dto.notes,
      enabledBy: dto.enabledBy,
    });

    this.logger.log({
      customerId,
      action: "surcharge_config.upserted",
    });

    return {
      id: result.id,
      customerId: result.customerId,
      allowCreditCard: result.allowCreditCard,
      surchargeType: result.surchargeType,
      surchargeValue: result.surchargeValue,
      reason: result.reason,
      notes: result.notes,
      enabledBy: result.enabledBy,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    };
  }

  async deleteConfig(customerId: string): Promise<void> {
    await this.surchargeConfigRepo.deleteByCustomer(customerId);

    this.logger.log({
      customerId,
      action: "surcharge_config.deleted",
    });
  }
}
