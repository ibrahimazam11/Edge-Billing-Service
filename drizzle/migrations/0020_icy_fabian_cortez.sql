CREATE TABLE "gateway_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"gateway_provider" text NOT NULL,
	"gateway_customer_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "gateway_provider" text DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_assignments" ADD CONSTRAINT "gateway_assignments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_gateway_assignments_customer_gateway" ON "gateway_assignments" USING btree ("customer_id","gateway_provider");--> statement-breakpoint
CREATE INDEX "idx_gateway_assignments_customer_id" ON "gateway_assignments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_gateway_assignments_gateway_provider" ON "gateway_assignments" USING btree ("gateway_provider");--> statement-breakpoint
CREATE INDEX "idx_payment_methods_gateway_provider" ON "payment_methods" USING btree ("gateway_provider");