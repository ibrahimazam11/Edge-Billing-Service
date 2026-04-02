import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase, TransactionClient } from "../database/types";
import { featureFlags } from "../database/schema/feature-flags";
import { generateId } from "../common/utils/uuid.util";

type FeatureFlag = typeof featureFlags.$inferSelect;

@Injectable()
export class FeatureFlagsRepository extends BaseRepository<
  typeof featureFlags
> {
  protected readonly table = featureFlags;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async findByKey(
    customerId: string,
    flagName: string,
  ): Promise<{ enabled: boolean } | null> {
    const [flag] = await this.db
      .select({ enabled: featureFlags.enabled })
      .from(featureFlags)
      .where(
        and(
          eq(featureFlags.customerId, customerId),
          eq(featureFlags.flagName, flagName),
        ),
      )
      .limit(1);
    return flag ?? null;
  }

  async findByCustomer(customerId: string): Promise<FeatureFlag[]> {
    return this.db
      .select()
      .from(featureFlags)
      .where(eq(featureFlags.customerId, customerId));
  }

  async upsert(
    customerId: string,
    flagName: string,
    enabled: boolean,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insert(featureFlags)
      .values({
        id: generateId(),
        customerId,
        flagName,
        enabled,
        metadata: metadata ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [featureFlags.customerId, featureFlags.flagName],
        set:
          metadata !== undefined
            ? { enabled, metadata, updatedAt: now }
            : { enabled, updatedAt: now },
      });
  }

  async disable(
    customerId: string,
    flagName: string,
  ): Promise<{ id: string } | undefined> {
    const now = new Date();
    const [updated] = await this.db
      .update(featureFlags)
      .set({ enabled: false, updatedAt: now })
      .where(
        and(
          eq(featureFlags.customerId, customerId),
          eq(featureFlags.flagName, flagName),
        ),
      )
      .returning({ id: featureFlags.id });
    return updated;
  }

  async bulkEnableInTx(
    customerIds: string[],
    flagName: string,
    tx: TransactionClient,
  ): Promise<void> {
    const now = new Date();
    for (const customerId of customerIds) {
      await this.conn(tx)
        .insert(featureFlags as never)
        .values({
          id: generateId(),
          customerId,
          flagName,
          enabled: true,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        } as never)
        .onConflictDoUpdate({
          target: [featureFlags.customerId, featureFlags.flagName],
          set: { enabled: true, updatedAt: now },
        } as never);
    }
  }

  async bulkDisableInTx(
    customerIds: string[],
    flagName: string,
    tx: TransactionClient,
  ): Promise<void> {
    const now = new Date();
    for (const customerId of customerIds) {
      await this.conn(tx)
        .update(featureFlags as never)
        .set({ enabled: false, updatedAt: now } as never)
        .where(
          and(
            eq(featureFlags.customerId, customerId),
            eq(featureFlags.flagName, flagName),
          ),
        );
    }
  }

  async countEnabledByFlagName(flagName: string): Promise<number> {
    const result = await this.db.execute(
      sql`SELECT COUNT(*)::int AS "count" FROM feature_flags WHERE flag_name = ${flagName} AND enabled = true`,
    );
    const row = result.rows[0] as { count: number } | undefined;
    return row?.count ?? 0;
  }
}
