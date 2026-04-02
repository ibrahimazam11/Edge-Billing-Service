import { Inject, Injectable, Logger } from "@nestjs/common";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { FeatureFlagsRepository } from "./feature-flags.repository";

export interface FeatureFlag {
  id: string;
  customerId: string;
  flagName: string;
  enabled: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class FeatureFlagService {
  private readonly logger = new Logger(FeatureFlagService.name);

  constructor(
    @Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase,
    private readonly featureFlagsRepo: FeatureFlagsRepository,
  ) {}

  async isEnabled(customerId: string, flagName: string): Promise<boolean> {
    const flag = await this.featureFlagsRepo.findByKey(customerId, flagName);
    return flag?.enabled ?? false;
  }

  async enableFlag(
    customerId: string,
    flagName: string,
    metadata?: Record<string, unknown>,
    correlationId?: string,
  ): Promise<void> {
    await this.featureFlagsRepo.upsert(customerId, flagName, true, metadata);

    this.logger.log({
      customerId,
      flagName,
      enabled: true,
      action: "flag.changed",
      correlationId,
    });
  }

  async disableFlag(
    customerId: string,
    flagName: string,
    correlationId?: string,
  ): Promise<void> {
    const updated = await this.featureFlagsRepo.disable(customerId, flagName);

    if (updated) {
      this.logger.log({
        customerId,
        flagName,
        enabled: false,
        action: "flag.changed",
        correlationId,
      });
    }
  }

  async enableFlagBulk(
    customerIds: string[],
    flagName: string,
    correlationId?: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.featureFlagsRepo.bulkEnableInTx(customerIds, flagName, tx);
    });

    this.logger.log({
      flagName,
      customerCount: customerIds.length,
      action: "flag.bulk_enabled",
      correlationId,
    });
  }

  async disableFlagBulk(
    customerIds: string[],
    flagName: string,
    correlationId?: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.featureFlagsRepo.bulkDisableInTx(customerIds, flagName, tx);
    });

    this.logger.log({
      flagName,
      customerCount: customerIds.length,
      action: "flag.bulk_disabled",
      correlationId,
    });
  }

  async getFlags(customerId: string): Promise<FeatureFlag[]> {
    const flags = await this.featureFlagsRepo.findByCustomer(customerId);

    return flags.map((f) => ({
      id: f.id,
      customerId: f.customerId,
      flagName: f.flagName,
      enabled: f.enabled,
      metadata: f.metadata as Record<string, unknown> | null,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    }));
  }
}
