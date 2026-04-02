export class ErrorResponseDto {
  statusCode!: number;
  error!: string;
  message!: string;
  details!: Record<string, unknown> | null;
}
