CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"stripe_payment_method_id" text NOT NULL,
	"type" varchar(20) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"last_four" varchar(4),
	"brand" varchar(50),
	"bank_name" varchar(255),
	"expiry_month" integer,
	"expiry_year" integer,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_payment_methods_customer_id" ON "payment_methods" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_payment_methods_stripe_payment_method_id" ON "payment_methods" USING btree ("stripe_payment_method_id");