CREATE TYPE "public"."reconciliation_status" AS ENUM('balanced', 'discrepancy_found', 'failed');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_type" AS ENUM('missing_internal', 'missing_stripe', 'amount_mismatch');--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" "reconciliation_status" NOT NULL,
	"records_compared" integer NOT NULL,
	"total_internal_amount_cents" bigint NOT NULL,
	"total_stripe_amount_cents" bigint NOT NULL,
	"error_reason" text,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_discrepancies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reconciliation_run_id" uuid NOT NULL,
	"type" "discrepancy_type" NOT NULL,
	"internal_reference_id" text,
	"stripe_transaction_id" text,
	"expected_amount_cents" bigint NOT NULL,
	"actual_amount_cents" bigint NOT NULL,
	"difference_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reconciliation_discrepancies" ADD CONSTRAINT "reconciliation_discrepancies_reconciliation_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("reconciliation_run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reconciliation_runs_period" ON "reconciliation_runs" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "idx_reconciliation_runs_status" ON "reconciliation_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_reconciliation_discrepancies_run_id" ON "reconciliation_discrepancies" USING btree ("reconciliation_run_id");