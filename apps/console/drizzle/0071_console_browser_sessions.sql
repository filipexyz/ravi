CREATE TABLE "console_browser_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" text NOT NULL,
  "auth_identity_id" uuid NOT NULL REFERENCES "auth_identities"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "console_browser_sessions_token_hash_unique" ON "console_browser_sessions" ("token_hash");
--> statement-breakpoint
CREATE INDEX "console_browser_sessions_user_idx" ON "console_browser_sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX "console_browser_sessions_expires_idx" ON "console_browser_sessions" ("expires_at");
