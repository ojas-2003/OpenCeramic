CREATE TYPE "public"."cell_status" AS ENUM('idle', 'pending', 'running', 'done', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."column_kind" AS ENUM('input', 'enrichment');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('person', 'company');--> statement-breakpoint
CREATE TYPE "public"."run_scope" AS ENUM('cell', 'column', 'table');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('planned', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "api_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"http_status" integer,
	"latency_ms" integer NOT NULL,
	"credits" integer DEFAULT 0 NOT NULL,
	"response_meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cells" (
	"row_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"value" jsonb,
	"status" "cell_status" DEFAULT 'idle' NOT NULL,
	"error_code" text,
	"error_message" text,
	"run_id" uuid,
	"provenance" jsonb,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "cells_row_id_column_id_pk" PRIMARY KEY("row_id","column_id")
);
--> statement-breakpoint
CREATE TABLE "columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "column_kind" NOT NULL,
	"enrichment_id" text,
	"enrichment_version" integer,
	"config" jsonb DEFAULT '{"inputs":{}}'::jsonb NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "enrichment_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"scope" "run_scope" NOT NULL,
	"target" jsonb NOT NULL,
	"status" "run_status" DEFAULT 'planned' NOT NULL,
	"plan" jsonb NOT NULL,
	"counts" jsonb DEFAULT '{"total":0,"done":0,"failed":0,"skipped":0,"cache_hits":0}'::jsonb NOT NULL,
	"estimated_credits" integer DEFAULT 0 NOT NULL,
	"actual_credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_row_id_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rows" ADD CONSTRAINT "rows_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_calls_created_at_idx" ON "api_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "cells_column_status_idx" ON "cells" USING btree ("column_id","status");--> statement-breakpoint
CREATE INDEX "cells_run_idx" ON "cells" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "columns_table_position_idx" ON "columns" USING btree ("table_id","position");--> statement-breakpoint
CREATE INDEX "rows_table_position_idx" ON "rows" USING btree ("table_id","position");