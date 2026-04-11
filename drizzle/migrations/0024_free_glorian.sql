ALTER TABLE "customers" ADD COLUMN "charge_day" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "is_prepaid" boolean DEFAULT true NOT NULL;