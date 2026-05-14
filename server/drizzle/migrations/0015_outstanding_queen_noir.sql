CREATE TABLE IF NOT EXISTS "ticket_aliases" (
	"alias_key" varchar(64) PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "auto_include_all_projects" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_aliases" ADD CONSTRAINT "ticket_aliases_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_aliases_ticket_idx" ON "ticket_aliases" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "boards_auto_include_unique_idx" ON "boards" USING btree ("auto_include_all_projects") WHERE "boards"."auto_include_all_projects" = true;