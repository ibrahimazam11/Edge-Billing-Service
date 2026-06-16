import { Inject, Injectable } from "@nestjs/common";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { migrationLogs } from "../database/schema/migration-logs";
import { generateId } from "../common/utils/uuid.util";

@Injectable()
export class CustomerMigrationLogsRepository extends BaseRepository<
  typeof migrationLogs
> {
  protected readonly table = migrationLogs;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  /**
   * Writes a per-step row into the shared `migration_logs` table. Script names
   * are prefixed `customer-migration-` so the new flow is queryable separately
   * from the legacy bulk-migration runs.
   */
  async writeStepLog(params: {
    runId: string;
    scriptName: string;
    monolithCustomerId: string;
    billingCustomerId: string | null;
    status: "succeeded" | "failed" | "skipped" | "rolled_back";
    errorMessage?: string | null;
    details?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.db.insert(migrationLogs).values({
      id: generateId(),
      runId: params.runId,
      scriptName: params.scriptName,
      monolithCustomerId: params.monolithCustomerId,
      billingCustomerId: params.billingCustomerId,
      status: params.status,
      errorMessage: params.errorMessage ?? null,
      details: (params.details ?? null) as never,
      createdAt: new Date(),
    });
  }
}
