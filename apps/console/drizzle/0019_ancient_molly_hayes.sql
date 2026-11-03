ALTER TABLE "runtime_trace_sessions" ADD COLUMN "source_channel" text;--> statement-breakpoint
ALTER TABLE "runtime_trace_sessions" ADD COLUMN "source_account_id" text;--> statement-breakpoint
ALTER TABLE "runtime_trace_sessions" ADD COLUMN "source_chat_id" text;--> statement-breakpoint
ALTER TABLE "runtime_trace_sessions" ADD COLUMN "source_thread_id" text;--> statement-breakpoint
ALTER TABLE "runtime_trace_sessions" ADD COLUMN "canonical_chat_id" text;--> statement-breakpoint
UPDATE "runtime_trace_sessions"
SET
  "source_channel" = NULLIF("safe_metadata_json" #>> '{source,channel}', ''),
  "source_account_id" = NULLIF("safe_metadata_json" #>> '{source,accountId}', ''),
  "source_chat_id" = NULLIF("safe_metadata_json" #>> '{source,chatId}', ''),
  "source_thread_id" = NULLIF("safe_metadata_json" #>> '{source,threadId}', ''),
  "canonical_chat_id" = NULLIF("safe_metadata_json" #>> '{source,canonicalChatId}', '')
WHERE "safe_metadata_json" ? 'source';--> statement-breakpoint
CREATE INDEX "runtime_trace_sessions_source_chat_idx" ON "runtime_trace_sessions" USING btree ("organization_id","source_channel","source_account_id","source_chat_id","started_at");--> statement-breakpoint
CREATE INDEX "runtime_trace_sessions_canonical_chat_idx" ON "runtime_trace_sessions" USING btree ("organization_id","canonical_chat_id","started_at");
