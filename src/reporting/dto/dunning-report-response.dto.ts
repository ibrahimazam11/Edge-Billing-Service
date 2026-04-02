export class RecoveryByAttempt {
  attemptNumber!: number;
  count!: number;
}

export class DunningReportResponseDto {
  totalInvoicesInDunning!: number;
  totalRecovered!: {
    count: number;
    amountCents: number;
  };
  totalEscalated!: {
    count: number;
    amountCents: number;
  };
  recoveryRate!: number;
  averageRecoveryAttempts!: number;
  recoveryByAttempt!: RecoveryByAttempt[];
  periodStart!: string;
  periodEnd!: string;
}
