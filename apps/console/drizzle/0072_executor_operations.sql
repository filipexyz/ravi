CREATE TABLE "executor_operations" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "organization_id" uuid NOT NULL,
 "user_id" uuid NOT NULL,
 "site_id" uuid NOT NULL,
 "action" text NOT NULL,
 "idempotency_key" text NOT NULL,
 "request_hash" text NOT NULL,
 "session_hash" text NOT NULL,
 "status" text DEFAULT 'pending' NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "completed_at" timestamp with time zone,
 CONSTRAINT "executor_operations_status" CHECK (status IN ('pending', 'completed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "executor_operations_scope_key" ON "executor_operations" ("organization_id", "user_id", "site_id", "action", "idempotency_key");
