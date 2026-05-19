CREATE TABLE IF NOT EXISTS "llm_obs_pending_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dimension" varchar(32) NOT NULL,
	"value" varchar(128) NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" varchar(16)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_id" uuid NOT NULL,
	"ticket_id" uuid,
	"service" varchar(64) NOT NULL,
	"operation" varchar(64) NOT NULL,
	"model" varchar(128) NOT NULL,
	"provider" varchar(64) NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_creation_input_tokens" integer,
	"cache_read_input_tokens" integer,
	"latency_ms" integer NOT NULL,
	"error_code" varchar(64),
	"dedup_key" varchar(256),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_observations_tokens_non_negative" CHECK ("llm_observations"."input_tokens" >= 0 AND "llm_observations"."output_tokens" >= 0 AND "llm_observations"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_observations_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_date" timestamp with time zone NOT NULL,
	"service" varchar(64) NOT NULL,
	"operation" varchar(64) NOT NULL,
	"model" varchar(128) NOT NULL,
	"provider" varchar(64) NOT NULL,
	"actor_id" uuid,
	"ticket_id" uuid,
	"call_count" integer NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_creation_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"sum_latency_ms" bigint NOT NULL,
	"p50_latency_ms" integer NOT NULL,
	"p95_latency_ms" integer NOT NULL,
	"p99_latency_ms" integer NOT NULL,
	"cost_usd_at_rollup" double precision NOT NULL,
	"error_count" integer NOT NULL,
	"rolled_up_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" varchar(128) NOT NULL,
	"provider" varchar(64) NOT NULL,
	"input_usd_per_mtok" double precision NOT NULL,
	"output_usd_per_mtok" double precision NOT NULL,
	"cache_creation_multiplier" double precision DEFAULT 1 NOT NULL,
	"cache_read_multiplier" double precision DEFAULT 0.1 NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_pricing_non_negative" CHECK ("model_pricing"."input_usd_per_mtok" >= 0 AND "model_pricing"."output_usd_per_mtok" >= 0 AND "model_pricing"."cache_creation_multiplier" >= 0 AND "model_pricing"."cache_read_multiplier" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_observations" ADD CONSTRAINT "llm_observations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_observations" ADD CONSTRAINT "llm_observations_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_observations_daily" ADD CONSTRAINT "llm_observations_daily_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_observations_daily" ADD CONSTRAINT "llm_observations_daily_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "llm_obs_pending_values_dim_value_unique" ON "llm_obs_pending_values" USING btree ("dimension","value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_obs_pending_values_unresolved_idx" ON "llm_obs_pending_values" USING btree ("dimension","last_seen_at") WHERE "llm_obs_pending_values"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_observations_occurred_at_idx" ON "llm_observations" USING btree ("occurred_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_observations_ticket_idx" ON "llm_observations" USING btree ("ticket_id","occurred_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_observations_service_op_idx" ON "llm_observations" USING btree ("service","operation","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_observations_actor_idx" ON "llm_observations" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "llm_observations_dedup_key_unique" ON "llm_observations" USING btree ("dedup_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "llm_observations_daily_bucket_dims_unique" ON "llm_observations_daily" USING btree ("bucket_date","service","operation","model","provider","actor_id","ticket_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_observations_daily_bucket_idx" ON "llm_observations_daily" USING btree ("bucket_date" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_observations_daily_ticket_idx" ON "llm_observations_daily" USING btree ("ticket_id","bucket_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_pricing_model_provider_idx" ON "model_pricing" USING btree ("model","provider");