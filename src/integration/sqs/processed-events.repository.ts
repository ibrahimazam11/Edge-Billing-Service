import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { BaseRepository } from "../../database/base.repository";
import { DRIZZLE_PROVIDER } from "../../database/database.provider";
import type { DrizzleDatabase, TransactionClient } from "../../database/types";
import { processedEvents } from "../../database/schema/processed-events";
import { isDuplicateKeyError } from "../../common/utils/error.util";

type ProcessedEvent = typeof processedEvents.$inferSelect;

@Injectable()
export class ProcessedEventsRepository extends BaseRepository<
  typeof processedEvents
> {
  protected readonly table = processedEvents;

  constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
    super(db);
  }

  /** Composite PK table — base CRUD methods are not supported. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override findById(_id: string, _tx?: TransactionClient): Promise<never> {
    return Promise.reject(
      new Error(
        "ProcessedEventsRepository: findById() is not supported. Use findByEventIdAndType() for composite PK lookup.",
      ),
    );
  }

  /** Composite PK table — base CRUD methods are not supported. */
  /* eslint-disable @typescript-eslint/no-unused-vars */
  override update(
    _id: string,
    _data: never,
    _tx?: TransactionClient,
  ): Promise<never> {
    /* eslint-enable @typescript-eslint/no-unused-vars */
    return Promise.reject(
      new Error(
        "ProcessedEventsRepository: update() is not supported. Table uses composite PK (eventId + eventType).",
      ),
    );
  }

  /** Composite PK table — base CRUD methods are not supported. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override deleteById(_id: string, _tx?: TransactionClient): Promise<never> {
    return Promise.reject(
      new Error(
        "ProcessedEventsRepository: deleteById() is not supported. Table uses composite PK (eventId + eventType).",
      ),
    );
  }

  async findByEventIdAndType(
    eventId: string,
    eventType: string,
  ): Promise<ProcessedEvent | null> {
    const [row] = await this.db
      .select()
      .from(processedEvents)
      .where(
        and(
          eq(processedEvents.eventId, eventId),
          eq(processedEvents.eventType, eventType),
        ),
      );
    return row ?? null;
  }

  async markProcessed(eventId: string, eventType: string): Promise<void> {
    try {
      await this.db.insert(processedEvents).values({ eventId, eventType });
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return;
      }
      throw error;
    }
  }
}
