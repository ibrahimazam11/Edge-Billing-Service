import { Injectable, Logger } from "@nestjs/common";
import { SqsService } from "@ssut/nestjs-sqs";
import type { SqsEnvelope } from "../../common/interfaces/envelope.interface";
import { generateId } from "../../common/utils/uuid.util";
import type {
  OutboundEventType,
  OutboundEventMap,
} from "./contracts/outbound-events";

@Injectable()
export class SqsProducerService {
  private readonly logger = new Logger(SqsProducerService.name);

  constructor(private readonly sqsService: SqsService) {}

  async publish<K extends OutboundEventType>(
    type: K,
    payload: OutboundEventMap[K],
    correlationId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const envelope: SqsEnvelope<OutboundEventMap[K]> = {
      version: "1.0",
      type,
      timestamp: new Date().toISOString(),
      correlationId,
      payload,
      ...(metadata && { metadata }),
    };

    const messageId = generateId();

    try {
      await this.sqsService.send("monolith-outbound", {
        id: messageId,
        body: envelope,
      });
    } catch (error) {
      this.logger.error({
        eventType: type,
        correlationId,
        action: "event.publish.failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    this.logger.log({
      eventType: type,
      correlationId,
      action: "event.published",
    });
  }
}
