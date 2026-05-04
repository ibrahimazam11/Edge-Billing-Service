CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"stripe_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"gateway_provider" text DEFAULT 'stripe' NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"customer_id" text,
	"charge_id" text,
	"invoice_id" text,
	"error_message" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "charge_day" SET DEFAULT 1;--> statement-breakpoint
CREATE INDEX "idx_webhook_events_stripe_event_id" ON "webhook_events" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_events_customer_id" ON "webhook_events" USING btree ("customer_id");