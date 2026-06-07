CREATE TYPE "public"."instance_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."project_member_role" AS ENUM('admin', 'editor', 'viewer');--> statement-breakpoint
ALTER TABLE "user_projects" ADD COLUMN "role" "project_member_role" NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "instance_role" "instance_role" DEFAULT 'member' NOT NULL;