CREATE TYPE "public"."plan_criterion_verdict" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."plan_review_verdict" AS ENUM('approved', 'changes_requested', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."plan_revision_status" AS ENUM('in_review', 'changes_requested', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('draft', 'in_review', 'changes_requested', 'approved', 'superseded');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"verdict" "plan_criterion_verdict" DEFAULT 'pending' NOT NULL,
	"reviewer_note" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"verdict" "plan_review_verdict" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"rev_number" integer NOT NULL,
	"narrative_md" text NOT NULL,
	"status" "plan_revision_status" DEFAULT 'in_review' NOT NULL,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"status" "plan_status" DEFAULT 'in_review' NOT NULL,
	"current_revision_id" uuid,
	"revision_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_ticket_id_unique" UNIQUE("ticket_id")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "plan_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "plan_anchor" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_criteria" ADD CONSTRAINT "plan_criteria_revision_id_plan_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."plan_revisions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_reviews" ADD CONSTRAINT "plan_reviews_revision_id_plan_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."plan_revisions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_reviews" ADD CONSTRAINT "plan_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plans" ADD CONSTRAINT "plans_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_criteria_revision_idx" ON "plan_criteria" USING btree ("revision_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_reviews_revision_idx" ON "plan_reviews" USING btree ("revision_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plan_revisions_plan_rev_unique" ON "plan_revisions" USING btree ("plan_id","rev_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_revisions_plan_idx" ON "plan_revisions" USING btree ("plan_id","rev_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plans_ticket_idx" ON "plans" USING btree ("ticket_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comments" ADD CONSTRAINT "comments_plan_revision_id_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."plan_revisions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_plan_revision_idx" ON "comments" USING btree ("plan_revision_id");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_plan_anchor_requires_revision" CHECK ("comments"."plan_anchor" IS NULL OR "comments"."plan_revision_id" IS NOT NULL);