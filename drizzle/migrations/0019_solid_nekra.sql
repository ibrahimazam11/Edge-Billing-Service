ALTER TABLE "payment_methods" ADD COLUMN "fallback_order" integer;--> statement-breakpoint
ALTER TABLE "dunning_attempts" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "dunning_attempts" ADD CONSTRAINT "dunning_attempts_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_dunning_attempts_payment_method_id" ON "dunning_attempts" USING btree ("payment_method_id");