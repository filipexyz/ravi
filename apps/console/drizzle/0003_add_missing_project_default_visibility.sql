ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "default_visibility" "visibility" DEFAULT 'private';
--> statement-breakpoint
UPDATE "projects" SET "default_visibility" = 'private' WHERE "default_visibility" IS NULL;
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "default_visibility" SET DEFAULT 'private';
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "default_visibility" SET NOT NULL;
