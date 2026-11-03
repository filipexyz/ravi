-- Idempotent, like 0057-0066: a preview build may apply it to a shared
-- database before it merges. The accessibility audit of a widget version
-- with widget.js (JS-CONTRACT J3); null until an org admin runs it.
ALTER TABLE "library_versions" ADD COLUMN IF NOT EXISTS "script_audit" jsonb;
