CREATE TABLE "dunning_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"charge_id" uuid,
	"attempt_number" integer NOT NULL,
	"scheduled_date" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dunning_attempts" ADD CONSTRAINT "dunning_attempts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_attempts" ADD CONSTRAINT "dunning_attempts_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_dunning_attempts_invoice_id" ON "dunning_attempts" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_dunning_attempts_status_scheduled_date" ON "dunning_attempts" USING btree ("status","scheduled_date");--> statement-breakpoint
CREATE INDEX "idx_charges_stripe_payment_intent_id" ON "charges" USING btree ("stripe_payment_intent_id");