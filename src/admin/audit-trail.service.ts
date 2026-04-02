import { Injectable } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import { AuditTrailRepository } from "./audit-trail.repository";

@Injectable()
export class AuditTrailService {
  constructor(private readonly auditTrailRepository: AuditTrailRepository) {}

  async createAuditRecord(params: {
    adminUserId: string;
    action: string;
    entityType: string;
    entityId: string;
    details?: unknown;
  }): Promise<void> {
    await this.auditTrailRepository.create({
      id: uuidv7(),
      adminUserId: params.adminUserId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      details: params.details ?? null,
    });
  }
}
