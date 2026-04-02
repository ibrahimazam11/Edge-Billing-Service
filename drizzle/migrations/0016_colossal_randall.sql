CREATE TABLE "audit_trail" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_user_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_audit_trail_admin_user_id" ON "audit_trail" USING btree ("admin_user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_trail_entity" ON "audit_trail" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_audit_trail_created_at" ON "audit_trail" USING btree ("created_at");