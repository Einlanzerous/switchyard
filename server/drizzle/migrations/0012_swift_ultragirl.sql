CREATE TYPE "public"."external_ref_kind" AS ENUM('github_pr', 'github_issue', 'github_commit', 'github_action', 'generic');--> statement-breakpoint
CREATE TYPE "public"."external_ref_state" AS ENUM('open', 'closed', 'merged', 'success', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ticket_external_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"kind" "external_ref_kind" NOT NULL,
	"url" text NOT NULL,
	"state" "external_ref_state",
	"title" text,
	"polled_at" timestamp with time zone,
	"polled_state_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_external_refs" ADD CONSTRAINT "ticket_external_refs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_external_refs" ADD CONSTRAINT "ticket_external_refs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_external_refs_url_unique" ON "ticket_external_refs" USING btree ("ticket_id","url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_external_refs_ticket_idx" ON "ticket_external_refs" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_external_refs_polled_idx" ON "ticket_external_refs" USING btree ("polled_at") WHERE "ticket_external_refs"."kind" <> 'generic';