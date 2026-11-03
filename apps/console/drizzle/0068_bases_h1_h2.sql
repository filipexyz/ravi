-- Idempotent, like 0057-0067: a preview build may apply it to a shared
-- database before it merges.
-- Bases H1+H2: the agent that made a ledger write for its accountable human
-- (installation-asserted), and filtered subscriptions (one active
-- subscription per installation and canonical filter).
ALTER TABLE "base_row_ledger" ADD COLUMN IF NOT EXISTS "agent_id" text;--> statement-breakpoint
ALTER TABLE "base_row_ledger" ADD COLUMN IF NOT EXISTS "local_installation_id" uuid;--> statement-breakpoint
ALTER TABLE "base_subscriptions" ADD COLUMN IF NOT EXISTS "filter_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "base_subscriptions" ADD COLUMN IF NOT EXISTS "filter_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "base_subscriptions_base_installation_active_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "base_subscriptions_base_installation_filter_active_unique" ON "base_subscriptions" USING btree ("base_id","local_installation_id","filter_key") WHERE "base_subscriptions"."status" = 'active';
