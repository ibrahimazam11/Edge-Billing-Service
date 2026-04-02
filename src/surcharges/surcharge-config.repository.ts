import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { surchargeConfigs } from "../database/schema/surcharge-configs";
import { generateId } from "../common/utils/uuid.util";

type SurchargeConfig = typeof surchargeConfigs.$inferSelect;

@Injectable()
export class SurchargeConfigRepository extends BaseRepository<
  typeof surchargeConfigs
> {
  protected readonly table = surchargeConfigs;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async findByCustomer(customerId: string): Promise<SurchargeConfig | null> {
    const [config] = await this.db
      .select()
      .from(surchargeConfigs)
      .where(eq(surchargeConfigs.customerId, customerId))
      .limit(1);
    return config ?? null;
  }

  async upsert(
    customerId: string,
    data: {
      allowCreditCard: boolean;
      surchargeType?: "percentage" | "flat_fee" | null;
      surchargeValue?: number | null;
      reason?: string | null;
      notes?: string | null;
      enabledBy?: string | null;
    },
  ): Promise<SurchargeConfig> {
    const now = new Date();
    const [result] = await this.db
      .insert(surchargeConfigs)
      .values({
        id: generateId(),
        customerId,
        allowCreditCard: data.allowCreditCard,
        surchargeType: data.surchargeType ?? null,
        surchargeValue: data.surchargeValue ?? null,
        reason: data.reason ?? null,
        notes: data.notes ?? null,
        enabledBy: data.enabledBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: surchargeConfigs.customerId,
        set: {
          allowCreditCard: data.allowCreditCard,
          surchargeType: data.surchargeType ?? null,
          surchargeValue: data.surchargeValue ?? null,
          reason: data.reason ?? null,
          notes: data.notes ?? null,
          enabledBy: data.enabledBy ?? null,
          updatedAt: now,
        },
      })
      .returning();
    if (!result) throw new Error("Expected row to be returned from UPSERT");
    return result;
  }

  async deleteByCustomer(customerId: string): Promise<void> {
    await this.db
      .delete(surchargeConfigs)
      .where(eq(surchargeConfigs.customerId, customerId));
  }
}
