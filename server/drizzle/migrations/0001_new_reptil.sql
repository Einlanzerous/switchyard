ALTER TABLE "tickets" ADD COLUMN "position" double precision;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tickets_position_idx" ON "tickets" USING btree ("status_id","position");