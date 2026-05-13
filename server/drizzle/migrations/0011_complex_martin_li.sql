CREATE TYPE "public"."custom_field_type" AS ENUM('text', 'number', 'boolean', 'url', 'select');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"key" varchar(80) NOT NULL,
	"label" varchar(200) NOT NULL,
	"type" "custom_field_type" NOT NULL,
	"options" jsonb,
	"show_on_card" boolean DEFAULT false NOT NULL,
	"show_on_create_form" boolean DEFAULT false NOT NULL,
	"show_on_filter_bar" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_fields_key_shape" CHECK ("custom_fields"."key" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "custom_fields_project_key_unique" ON "custom_fields" USING btree ("project_id","key") WHERE "custom_fields"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "custom_fields_global_key_unique" ON "custom_fields" USING btree ("key") WHERE "custom_fields"."project_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_fields_project_idx" ON "custom_fields" USING btree ("project_id");