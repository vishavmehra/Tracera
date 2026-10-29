CREATE TYPE "public"."dependency_snapshot_status" AS ENUM('queued', 'preparing', 'ready', 'failed', 'cancelled', 'expired');--> statement-breakpoint
ALTER TYPE "public"."investigation_stage" ADD VALUE 'prepare_dependencies' BEFORE 'plan_reproduction';--> statement-breakpoint
CREATE TABLE "dependency_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"cache_key" text NOT NULL,
	"manager" text NOT NULL,
	"lockfile" jsonb NOT NULL,
	"manifests" jsonb NOT NULL,
	"registry" text NOT NULL,
	"image" text NOT NULL,
	"status" "dependency_snapshot_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"volume" text,
	"seal" jsonb,
	"egress" jsonb,
	"log_sha256" text,
	"duration_ms" integer,
	"error" jsonb,
	"cancel_requested_at" timestamp with time zone,
	"created_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD COLUMN "dependency_snapshot_id" text;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD COLUMN "environment" jsonb;--> statement-breakpoint
ALTER TABLE "dependency_snapshots" ADD CONSTRAINT "dependency_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_snapshots" ADD CONSTRAINT "dependency_snapshots_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_snapshots" ADD CONSTRAINT "dependency_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_snapshots_repository_id_cache_key_index" ON "dependency_snapshots" USING btree ("repository_id","cache_key");--> statement-breakpoint
CREATE INDEX "dependency_snapshots_workspace_id_repository_id_created_at_index" ON "dependency_snapshots" USING btree ("workspace_id","repository_id","created_at");--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_dependency_snapshot_id_dependency_snapshots_id_fk" FOREIGN KEY ("dependency_snapshot_id") REFERENCES "public"."dependency_snapshots"("id") ON DELETE set null ON UPDATE no action;