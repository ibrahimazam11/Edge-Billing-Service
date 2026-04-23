ALTER TABLE "invoices" ADD COLUMN "type" varchar(20) DEFAULT 'recurring' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_invoices_type" ON "invoices" USING btree ("type");