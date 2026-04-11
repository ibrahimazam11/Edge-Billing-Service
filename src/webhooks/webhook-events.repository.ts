import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { BaseRepository } from "../database/base.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";
import type { DrizzleDatabase, TransactionClient } from "../database/types";
import { webhookEvents } from "../database/schema/webhook-events";

type WebhookEvent = typeof webhookEvents.$inferSelect;
type WebhookEventInsert = typeof webhookEvents.$inferInsert;

@Injectable()
export class WebhookEventsRepository extends BaseRepository<
  typeof webhookEvents
> {
  protected readonly table = webhookEvents;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  async logEvent(
    data: Pick<
      WebhookEventInsert,
      "stripeEventId" | "eventType" | "gatewayProvider" | "payload"
    >,
  ): Promise<WebhookEvent> {
    const [row] = await this.db
      .insert(webhookEvents)
      .values({
        stripeEventId: data.stripeEventId,
        eventType: data.eventType,
        gatewayProvider: data.gatewayProvider,
        payload: data.payload,
        status: "received",
      })
      .returning();
    return row;
  }

  async updateStatus(
    id: string,
    status: string,
    context?: {
      customerId?: string;
      chargeId?: string;
      invoiceId?: string;
      errorMessage?: string;
    },
    tx?: TransactionClient,
  ): Promise<void> {
    await this.conn(tx)
      .update(webhookEvents)
      .set({
        status,
        processedAt: new Date(),
        ...(context?.customerId && { customerId: context.customerId }),
        ...(context?.chargeId && { chargeId: context.chargeId }),
        ...(context?.invoiceId && { invoiceId: context.invoiceId }),
        ...(context?.errorMessage && { errorMessage: context.errorMessage }),
      })
      .where(eq(webhookEvents.id, id));
  }

  async findByStripeEventId(stripeEventId: string): Promise<WebhookEvent[]> {
    return this.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, stripeEventId));
  }
}
