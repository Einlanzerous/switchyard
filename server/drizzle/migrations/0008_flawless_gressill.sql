ALTER TABLE "rule_firings" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "schedule_cron" text;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "schedule_tz" varchar(80);--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "target_query" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rule_firings" ADD CONSTRAINT "rule_firings_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rules_scheduled_idx" ON "rules" USING btree ("enabled","schedule_cron") WHERE "rules"."enabled" = true AND "rules"."schedule_cron" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_trigger_mode_xor" CHECK ((
        ("rules"."schedule_cron" IS NULL AND coalesce(array_length("rules"."trigger_event_types", 1), 0) > 0)
        OR
        ("rules"."schedule_cron" IS NOT NULL AND coalesce(array_length("rules"."trigger_event_types", 1), 0) = 0)
      ));