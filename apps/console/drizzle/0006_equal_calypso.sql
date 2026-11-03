CREATE TYPE "public"."mail_attachment_status" AS ENUM('unscanned', 'available', 'quarantined', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."mail_delivery_event_status" AS ENUM('recorded', 'ignored', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mail_domain_status" AS ENUM('pending', 'verified', 'disabled', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."mail_key_ref_status" AS ENUM('active', 'rotated', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."mail_key_scope" AS ENUM('organization', 'project', 'mailbox', 'agent');--> statement-breakpoint
CREATE TYPE "public"."mail_mailbox_status" AS ENUM('active', 'disabled', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."mail_message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."mail_message_status" AS ENUM('received', 'queued', 'sent', 'delivered', 'failed', 'rejected', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."mail_route_action" AS ENUM('deliver', 'reject', 'drop', 'forward');--> statement-breakpoint
CREATE TYPE "public"."mail_route_match_type" AS ENUM('exact', 'local_part', 'catch_all', 'pattern');--> statement-breakpoint
CREATE TYPE "public"."mail_route_status" AS ENUM('active', 'disabled', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."mail_thread_status" AS ENUM('active', 'archived', 'deleted');--> statement-breakpoint
CREATE TABLE "mail_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"mailbox_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"filename_cipher_ref" jsonb,
	"content_type" text,
	"size_bytes" bigint,
	"sha256" text,
	"object_cipher_ref" jsonb NOT NULL,
	"status" "mail_attachment_status" DEFAULT 'unscanned' NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_delivery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"message_id" uuid,
	"event_type" text NOT NULL,
	"provider_adapter" text NOT NULL,
	"provider_event_ref_hash" text,
	"status" "mail_delivery_event_status" DEFAULT 'recorded' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"status" "mail_domain_status" DEFAULT 'pending' NOT NULL,
	"provider_adapter" text NOT NULL,
	"dns_status_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auth_status_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_key_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"mailbox_id" uuid,
	"key_scope" "mail_key_scope" NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"key_version" integer DEFAULT 1 NOT NULL,
	"algorithm" text NOT NULL,
	"wrapped_key_ref" text NOT NULL,
	"aad_hash" text,
	"status" "mail_key_ref_status" DEFAULT 'active' NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"mailbox_id" uuid NOT NULL,
	"thread_id" uuid,
	"direction" "mail_message_direction" NOT NULL,
	"provider_adapter" text NOT NULL,
	"provider_message_ref_hash" text,
	"internet_message_id_hash" text,
	"from_hash" text,
	"to_hashes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject_cipher_ref" jsonb,
	"raw_mime_cipher_ref" jsonb NOT NULL,
	"parsed_body_cipher_ref" jsonb,
	"headers_cipher_ref" jsonb NOT NULL,
	"status" "mail_message_status" DEFAULT 'received' NOT NULL,
	"size_bytes" bigint,
	"received_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"mailbox_id" uuid,
	"match_type" "mail_route_match_type" NOT NULL,
	"pattern" text NOT NULL,
	"action" "mail_route_action" NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" "mail_route_status" DEFAULT 'active' NOT NULL,
	"policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"mailbox_id" uuid NOT NULL,
	"contact_id" text,
	"subject_cipher_ref" jsonb,
	"normalized_subject_hash" text,
	"status" "mail_thread_status" DEFAULT 'active' NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"agent_id" text,
	"local_part" text NOT NULL,
	"domain_id" uuid NOT NULL,
	"address" text NOT NULL,
	"status" "mail_mailbox_status" DEFAULT 'active' NOT NULL,
	"default_visibility" "visibility" DEFAULT 'private' NOT NULL,
	"key_scope" "mail_key_scope" DEFAULT 'mailbox' NOT NULL,
	"created_by_user_id" uuid,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD CONSTRAINT "mail_attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD CONSTRAINT "mail_attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD CONSTRAINT "mail_attachments_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD CONSTRAINT "mail_attachments_message_id_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_delivery_events" ADD CONSTRAINT "mail_delivery_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_delivery_events" ADD CONSTRAINT "mail_delivery_events_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_delivery_events" ADD CONSTRAINT "mail_delivery_events_message_id_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mail_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_key_refs" ADD CONSTRAINT "mail_key_refs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_key_refs" ADD CONSTRAINT "mail_key_refs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_key_refs" ADD CONSTRAINT "mail_key_refs_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_thread_id_mail_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_routes" ADD CONSTRAINT "mail_routes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_routes" ADD CONSTRAINT "mail_routes_domain_id_mail_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."mail_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_routes" ADD CONSTRAINT "mail_routes_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_domain_id_mail_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."mail_domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_attachments_org_idx" ON "mail_attachments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mail_attachments_project_idx" ON "mail_attachments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mail_attachments_mailbox_idx" ON "mail_attachments" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "mail_attachments_message_idx" ON "mail_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "mail_attachments_sha256_idx" ON "mail_attachments" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "mail_attachments_status_idx" ON "mail_attachments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_delivery_events_provider_ref_unique" ON "mail_delivery_events" USING btree ("organization_id","provider_adapter","provider_event_ref_hash") WHERE "mail_delivery_events"."provider_event_ref_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mail_delivery_events_org_idx" ON "mail_delivery_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mail_delivery_events_mailbox_idx" ON "mail_delivery_events" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "mail_delivery_events_message_idx" ON "mail_delivery_events" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "mail_delivery_events_type_idx" ON "mail_delivery_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "mail_delivery_events_occurred_idx" ON "mail_delivery_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_domains_org_domain_unique" ON "mail_domains" USING btree ("organization_id","domain");--> statement-breakpoint
CREATE INDEX "mail_domains_org_idx" ON "mail_domains" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mail_domains_domain_idx" ON "mail_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "mail_domains_status_idx" ON "mail_domains" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_key_refs_resource_version_unique" ON "mail_key_refs" USING btree ("organization_id","resource_type","resource_id","key_version");--> statement-breakpoint
CREATE INDEX "mail_key_refs_org_idx" ON "mail_key_refs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mail_key_refs_project_idx" ON "mail_key_refs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mail_key_refs_mailbox_idx" ON "mail_key_refs" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "mail_key_refs_scope_idx" ON "mail_key_refs" USING btree ("key_scope");--> statement-breakpoint
CREATE INDEX "mail_key_refs_status_idx" ON "mail_key_refs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_messages_provider_ref_unique" ON "mail_messages" USING btree ("organization_id","provider_adapter","provider_message_ref_hash") WHERE "mail_messages"."provider_message_ref_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mail_messages_org_idx" ON "mail_messages" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mail_messages_project_idx" ON "mail_messages" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mail_messages_mailbox_idx" ON "mail_messages" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "mail_messages_thread_idx" ON "mail_messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "mail_messages_internet_id_idx" ON "mail_messages" USING btree ("internet_message_id_hash");--> statement-breakpoint
CREATE INDEX "mail_messages_received_idx" ON "mail_messages" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX "mail_messages_sent_idx" ON "mail_messages" USING btree ("organization_id","sent_at");--> statement-breakpoint
CREATE INDEX "mail_messages_status_idx" ON "mail_messages" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_routes_domain_match_unique" ON "mail_routes" USING btree ("domain_id","match_type","pattern");--> statement-breakpoint
CREATE INDEX "mail_routes_org_idx" ON "mail_routes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mail_routes_domain_idx" ON "mail_routes" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "mail_routes_mailbox_idx" ON "mail_routes" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "mail_routes_match_idx" ON "mail_routes" USING btree ("domain_id","match_type","priority");--> statement-breakpoint
CREATE INDEX "mail_routes_status_idx" ON "mail_routes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mail_threads_org_idx" ON "mail_threads" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mail_threads_project_idx" ON "mail_threads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mail_threads_mailbox_idx" ON "mail_threads" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "mail_threads_contact_idx" ON "mail_threads" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "mail_threads_subject_hash_idx" ON "mail_threads" USING btree ("normalized_subject_hash");--> statement-breakpoint
CREATE INDEX "mail_threads_last_message_idx" ON "mail_threads" USING btree ("organization_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_address_unique" ON "mailboxes" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_domain_local_unique" ON "mailboxes" USING btree ("domain_id","local_part");--> statement-breakpoint
CREATE INDEX "mailboxes_org_idx" ON "mailboxes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mailboxes_project_idx" ON "mailboxes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mailboxes_agent_idx" ON "mailboxes" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "mailboxes_domain_idx" ON "mailboxes" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "mailboxes_status_idx" ON "mailboxes" USING btree ("status");