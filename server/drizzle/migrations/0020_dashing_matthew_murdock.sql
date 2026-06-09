CREATE TYPE "public"."token_kind" AS ENUM('personal', 'agent', 'dashboard');--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "kind" "token_kind" DEFAULT 'personal' NOT NULL;