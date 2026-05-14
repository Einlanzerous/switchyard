CREATE TYPE "public"."ticket_template_overlap_policy" AS ENUM('skip', 'always', 'reuse_open');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ticket_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" "ticket_type" DEFAULT 'task' NOT NULL,
	"priority" "priority",
	"assignee_id" uuid,
	"parent_id" uuid,
	"label_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"due_date_offset_days" integer,
	"schedule_cron" text,
	"schedule_tz" varchar(80),
	"trigger_at" timestamp with time zone,
	"lead_days" integer DEFAULT 0 NOT NULL,
	"overlap_policy" "ticket_template_overlap_policy" DEFAULT 'skip' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_templates_schedule_mode_xor" CHECK ((
        ("ticket_templates"."schedule_cron" IS NOT NULL AND "ticket_templates"."trigger_at" IS NULL)
        OR
        ("ticket_templates"."schedule_cron" IS NULL AND "ticket_templates"."trigger_at" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "template_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_templates" ADD CONSTRAINT "ticket_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_templates" ADD CONSTRAINT "ticket_templates_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_templates" ADD CONSTRAINT "ticket_templates_parent_id_tickets_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_templates" ADD CONSTRAINT "ticket_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_templates_project_idx" ON "ticket_templates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_templates_enabled_idx" ON "ticket_templates" USING btree ("enabled") WHERE "ticket_templates"."enabled" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_templates_scheduled_idx" ON "ticket_templates" USING btree ("enabled","schedule_cron") WHERE "ticket_templates"."enabled" = true AND "ticket_templates"."schedule_cron" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_templates_trigger_idx" ON "ticket_templates" USING btree ("enabled","trigger_at") WHERE "ticket_templates"."enabled" = true AND "ticket_templates"."trigger_at" IS NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tickets" ADD CONSTRAINT "tickets_template_id_ticket_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."ticket_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tickets_template_idx" ON "tickets" USING btree ("template_id") WHERE "tickets"."template_id" IS NOT NULL;