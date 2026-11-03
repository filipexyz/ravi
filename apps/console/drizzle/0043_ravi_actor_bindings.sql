CREATE TYPE "public"."ravi_actor_binding_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TABLE "ravi_actor_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"console_user_id" uuid NOT NULL,
	"contact_id" text NOT NULL,
	"platform_identities_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "ravi_actor_binding_status" DEFAULT 'active' NOT NULL,
	"linked_by" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ravi_actor_bindings" ADD CONSTRAINT "ravi_actor_bindings_installation_id_local_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."local_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_actor_bindings" ADD CONSTRAINT "ravi_actor_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_actor_bindings" ADD CONSTRAINT "ravi_actor_bindings_console_user_id_users_id_fk" FOREIGN KEY ("console_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_actor_bindings" ADD CONSTRAINT "ravi_actor_bindings_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ravi_actor_bindings_installation_contact_active_unique" ON "ravi_actor_bindings" USING btree ("installation_id","contact_id") WHERE "ravi_actor_bindings"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ravi_actor_bindings_installation_user_idx" ON "ravi_actor_bindings" USING btree ("installation_id","console_user_id");--> statement-breakpoint
CREATE INDEX "ravi_actor_bindings_org_status_idx" ON "ravi_actor_bindings" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "ravi_actor_bindings_contact_idx" ON "ravi_actor_bindings" USING btree ("contact_id");