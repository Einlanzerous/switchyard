ALTER TABLE "users" ADD COLUMN "email" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree ("email") WHERE "users"."deleted_at" IS NULL;