CREATE TYPE "public"."patch_analysis_status" AS ENUM('queued', 'running', 'completed', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "patch_analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"base_ref" text NOT NULL,
	"base_sha" text NOT NULL,
	"head_ref" text,
	"head_sha" text,
	"diff_sha256" text,
	"merge_base" boolean DEFAULT false NOT NULL,
	"options" jsonb NOT NULL,
	"cache_key" text NOT NULL,
	"status" "patch_analysis_status" NOT NULL,
	"progress" jsonb,
	"result" jsonb,
	"error" jsonb,
	"cancel_requested_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patch_proposals" ADD COLUMN "impact" jsonb;--> statement-breakpoint
ALTER TABLE "patch_analyses" ADD CONSTRAINT "patch_analyses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_analyses" ADD CONSTRAINT "patch_analyses_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_analyses" ADD CONSTRAINT "patch_analyses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patch_analyses_repository_id_cache_key_index" ON "patch_analyses" USING btree ("repository_id","cache_key");--> statement-breakpoint
CREATE INDEX "patch_analyses_workspace_id_repository_id_created_at_index" ON "patch_analyses" USING btree ("workspace_id","repository_id","created_at");