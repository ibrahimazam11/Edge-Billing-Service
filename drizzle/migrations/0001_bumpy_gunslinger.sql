CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"monolith_customer_id" text NOT NULL,
	"stripe_customer_id" text,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_customers_monolith_customer_id" ON "customers" USING btree ("monolith_customer_id");--> statement-breakpoint
CREATE INDEX "idx_customers_stripe_customer_id" ON "customers" USING btree ("stripe_customer_id");