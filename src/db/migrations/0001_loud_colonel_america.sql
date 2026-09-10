CREATE TYPE "public"."source_kind" AS ENUM('saved_search', 'tracker');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('active', 'paused', 'error');--> statement-breakpoint
CREATE TABLE "row_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"kind" "source_kind" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "source_status" DEFAULT 'active' NOT NULL,
	"auto_enrich" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "rows" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "rows" ADD COLUMN "identity_key" text;--> statement-breakpoint
ALTER TABLE "rows" ADD COLUMN "signal" jsonb;--> statement-breakpoint
ALTER TABLE "row_sources" ADD CONSTRAINT "row_sources_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "row_sources_table_idx" ON "row_sources" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "row_sources_status_polled_idx" ON "row_sources" USING btree ("status","last_polled_at");--> statement-breakpoint
ALTER TABLE "rows" ADD CONSTRAINT "rows_source_id_row_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."row_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rows_table_identity_idx" ON "rows" USING btree ("table_id","identity_key") WHERE "rows"."identity_key" is not null;