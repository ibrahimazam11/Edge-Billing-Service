export interface CustomerMigrationStatus {
  customerId: string;
  migrationStatus: "migrated" | "pending" | "failed";
  dualWriteEnabled: boolean;
  billingServiceEnabled: boolean;
  lastMigrationScript: string | null;
  lastMigrationDate: string | null;
  errorMessage: string | null;
}

export interface AggregateMigrationStatus {
  totalCustomers: number;
  migrated: number;
  pending: number;
  failed: number;
  dualWriteActive: number;
}

export type MigrationStatusResponse =
  | { type: "customer"; data: CustomerMigrationStatus }
  | { type: "aggregate"; data: AggregateMigrationStatus };
