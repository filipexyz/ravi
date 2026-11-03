CREATE TYPE "public"."agent_inbox_outbox_status" AS ENUM('pending', 'publishing', 'published', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TABLE "agent_inbox_outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inbox_item_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"subject" text DEFAULT 'ravi.console.inbox.item' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "agent_inbox_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"published_at" timestamp with time zone,
	"dead_letter_at" timestamp with time zone,
	"last_error_code" text,
	"correlation_id" text NOT NULL,
	"trace_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_inbox_outbox_events" ADD CONSTRAINT "agent_inbox_outbox_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox_outbox_events" ADD CONSTRAINT "agent_inbox_outbox_events_inbox_item_id_agent_inbox_items_id_fk" FOREIGN KEY ("inbox_item_id") REFERENCES "public"."agent_inbox_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbox_outbox_events_item_unique" ON "agent_inbox_outbox_events" USING btree ("inbox_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbox_outbox_events_org_event_unique" ON "agent_inbox_outbox_events" USING btree ("organization_id","event_id");--> statement-breakpoint
CREATE INDEX "agent_inbox_outbox_events_status_next_idx" ON "agent_inbox_outbox_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "agent_inbox_outbox_events_lock_idx" ON "agent_inbox_outbox_events" USING btree ("locked_until");--> statement-breakpoint
CREATE INDEX "agent_inbox_outbox_events_org_status_idx" ON "agent_inbox_outbox_events" USING btree ("organization_id","status");