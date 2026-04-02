export class BulkOperationResultDto {
  subscriptionId!: string;
  success!: boolean;
  reason?: string;
}

export class BulkOperationResponseDto {
  successCount!: number;
  failureCount!: number;
  results!: BulkOperationResultDto[];
}
