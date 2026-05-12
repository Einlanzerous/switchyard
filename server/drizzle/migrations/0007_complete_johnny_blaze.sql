ALTER TABLE "rules" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "webhook_secret" text;