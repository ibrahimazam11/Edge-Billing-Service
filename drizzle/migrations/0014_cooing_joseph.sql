CREATE TYPE "public"."surcharge_type" AS ENUM('percentage', 'flat_fee');--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"flag_name" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surcharge_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"allow_credit_card" boolean DEFAULT false NOT NULL,
	"surcharge_type" "surcharge_type",
	"surcharge_value" integer,
	"reason" text,
	"notes" text,
	"enabled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surcharge_configs" ADD CONSTRAINT "surcharge_configs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feature_flags_customer_flag" ON "feature_flags" USING btree ("customer_id","flag_name");--> statement-breakpoint
CREATE INDEX "idx_feature_flags_customer_id" ON "feature_flags" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_feature_flags_flag_name_enabled" ON "feature_flags" USING btree ("flag_name","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_surcharge_configs_customer_id" ON "surcharge_configs" USING btree ("customer_id");