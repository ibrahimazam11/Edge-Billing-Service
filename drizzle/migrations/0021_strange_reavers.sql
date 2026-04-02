ALTER TABLE "reconciliation_discrepancies" ADD COLUMN "dispute_status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "reconciliation_discrepancies" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "reconciliation_discrepancies" ADD COLUMN "resolution_notes" text;--> statement-breakpoint
ALTER TABLE "reconciliation_discrepancies" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_invoices_created_at" ON "invoices" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_dunning_attempts_created_at" ON "dunning_attempts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_reconciliation_discrepancies_dispute_status" ON "reconciliation_discrepancies" USING btree ("dispute_status");