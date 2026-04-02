import { Injectable, Logger } from "@nestjs/common";
import { ProcessedEventsRepository } from "./processed-events.repository";

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    private readonly processedEventsRepository: ProcessedEventsRepository,
  ) {}

  async isProcessed(eventId: string, eventType: string): Promise<boolean> {
    const existing = await this.processedEventsRepository.findByEventIdAndType(
      eventId,
      eventType,
    );
    const isDuplicate = existing !== null;

    if (isDuplicate) {
      this.logger.debug({
        message: "Duplicate event detected",
        eventId,
        eventType,
      });
    }

    return isDuplicate;
  }

  async markProcessed(eventId: string, eventType: string): Promise<void> {
    await this.processedEventsRepository.markProcessed(eventId, eventType);
  }
}
