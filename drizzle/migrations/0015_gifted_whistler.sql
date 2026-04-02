CREATE TABLE "migration_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"script_name" varchar(255) NOT NULL,
	"monolith_customer_id" varchar(255) NOT NULL,
	"billing_customer_id" uuid,
	"status" varchar(20) NOT NULL,
	"error_message" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
CREATE INDEX "idx_migration_logs_run_id" ON "migration_logs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_migration_logs_monolith_customer_id" ON "migration_logs" USING btree ("monolith_customer_id");