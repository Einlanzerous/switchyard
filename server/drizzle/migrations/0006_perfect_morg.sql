CREATE TYPE "public"."rule_firing_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'abandoned', 'skipped');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rule_firings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"event_id" uuid,
	"status" "rule_firing_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"result_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger_event_types" text[] NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rule_firings" ADD CONSTRAINT "rule_firings_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rule_firings" ADD CONSTRAINT "rule_firings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rules" ADD CONSTRAINT "rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rule_firings_pending_idx" ON "rule_firings" USING btree ("next_attempt_at") WHERE "rule_firings"."status" IN ('pending', 'failed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rule_firings_rule_idx" ON "rule_firings" USING btree ("rule_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rules_project_idx" ON "rules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rules_enabled_idx" ON "rules" USING btree ("enabled") WHERE "rules"."enabled" = true;