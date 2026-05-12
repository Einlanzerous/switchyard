CREATE TYPE "public"."ticket_link_type" AS ENUM('blocks', 'relates_to', 'duplicates');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ticket_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_ticket_id" uuid NOT NULL,
	"target_ticket_id" uuid NOT NULL,
	"type" "ticket_link_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "ticket_links_no_self_link" CHECK ("ticket_links"."source_ticket_id" <> "ticket_links"."target_ticket_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_source_ticket_id_tickets_id_fk" FOREIGN KEY ("source_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_target_ticket_id_tickets_id_fk" FOREIGN KEY ("target_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_links_edge_unique" ON "ticket_links" USING btree ("source_ticket_id","target_ticket_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_links_source_idx" ON "ticket_links" USING btree ("source_ticket_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_links_target_idx" ON "ticket_links" USING btree ("target_ticket_id");