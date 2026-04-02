export class AuditTrailSearchResponseDto {
  id!: string;
  adminUserId!: string;
  action!: string;
  entityType!: string;
  entityId!: string;
  details!: unknown;
  createdAt!: string;
}
