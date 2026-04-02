import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase } from "../database/types";
import { gatewayAssignments } from "../database/schema/gateway-assignments";

type GatewayAssignment = typeof gatewayAssignments.$inferSelect;

@Injectable()
export class GatewayAssignmentsRepository extends BaseRepository<
  typeof gatewayAssignments
> {
  protected readonly table = gatewayAssignments;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async findByCustomer(customerId: string): Promise<GatewayAssignment[]> {
    return this.db
      .select()
      .from(gatewayAssignments)
      .where(eq(gatewayAssignments.customerId, customerId))
      .orderBy(desc(gatewayAssignments.createdAt));
  }

  async findByCustomerAndProvider(
    customerId: string,
    gatewayProvider: string,
  ): Promise<GatewayAssignment | null> {
    const [row] = await this.db
      .select()
      .from(gatewayAssignments)
      .where(
        and(
          eq(gatewayAssignments.customerId, customerId),
          eq(gatewayAssignments.gatewayProvider, gatewayProvider),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async updateGatewayCustomerId(
    id: string,
    gatewayCustomerId: string,
  ): Promise<void> {
    await this.db
      .update(gatewayAssignments)
      .set({ gatewayCustomerId, updatedAt: new Date() })
      .where(eq(gatewayAssignments.id, id));
  }
}
