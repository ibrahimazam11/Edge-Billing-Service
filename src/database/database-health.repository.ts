import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE_PROVIDER } from "./database.provider";
import type { DrizzleDatabase } from "./types";

/**
 * Standalone infrastructure repository for database connectivity checks.
 * Does NOT extend BaseRepository — no associated table.
 */
@Injectable()
export class DatabaseHealthRepository {
  constructor(@Inject(DRIZZLE_PROVIDER) private readonly db: DrizzleDatabase) {}

  async ping(): Promise<boolean> {
    await this.db.execute(sql`SELECT 1`);
    return true;
  }
}
