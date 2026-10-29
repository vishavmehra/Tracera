CREATE TYPE "public"."assessment_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."snapshot_status" AS ENUM('queued', 'indexing', 'ready', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "assessments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"snapshot_id" text,
	"commit_sha" text NOT NULL,
	"request" text NOT NULL,
	"targets" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "assessment_status" NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"created_by" text NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_edges" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "graph_edges_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"snapshot_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_key" text NOT NULL,
	"to_key" text,
	"target_text" text,
	"certainty" text NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_file_cache" (
	"repository_id" text NOT NULL,
	"extractor_version" text NOT NULL,
	"path" text NOT NULL,
	"object_id" text NOT NULL,
	"extraction" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_file_cache_repository_id_extractor_version_path_object_id_pk" PRIMARY KEY("repository_id","extractor_version","path","object_id")
);
--> statement-breakpoint
CREATE TABLE "graph_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"path" text,
	"start_line" integer,
	"end_line" integer,
	"language" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"ref" text NOT NULL,
	"commit_sha" text NOT NULL,
	"status" "snapshot_status" NOT NULL,
	"extractor_version" text NOT NULL,
	"previous_snapshot_id" text,
	"profile" jsonb,
	"coverage" jsonb,
	"stats" jsonb,
	"error" jsonb,
	"requested_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_executions" ADD COLUMN "assessment_id" text;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_snapshot_id_repository_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."repository_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_snapshot_id_repository_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."repository_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_file_cache" ADD CONSTRAINT "graph_file_cache_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_snapshot_id_repository_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."repository_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_snapshots" ADD CONSTRAINT "repository_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_snapshots" ADD CONSTRAINT "repository_snapshots_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessments_workspace_id_repository_id_created_at_index" ON "assessments" USING btree ("workspace_id","repository_id","created_at");--> statement-breakpoint
CREATE INDEX "graph_edges_snapshot_id_from_key_index" ON "graph_edges" USING btree ("snapshot_id","from_key");--> statement-breakpoint
CREATE INDEX "graph_edges_snapshot_id_to_key_index" ON "graph_edges" USING btree ("snapshot_id","to_key");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_nodes_snapshot_id_key_index" ON "graph_nodes" USING btree ("snapshot_id","key");--> statement-breakpoint
CREATE INDEX "graph_nodes_snapshot_id_kind_index" ON "graph_nodes" USING btree ("snapshot_id","kind");--> statement-breakpoint
CREATE INDEX "graph_nodes_snapshot_id_path_index" ON "graph_nodes" USING btree ("snapshot_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_snapshots_repository_id_commit_sha_extractor_version_index" ON "repository_snapshots" USING btree ("repository_id","commit_sha","extractor_version");--> statement-breakpoint
CREATE INDEX "repository_snapshots_workspace_id_repository_id_created_at_index" ON "repository_snapshots" USING btree ("workspace_id","repository_id","created_at");