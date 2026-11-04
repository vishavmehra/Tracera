CREATE TYPE "public"."github_installation_status" AS ENUM('active', 'suspended', 'removed');--> statement-breakpoint
CREATE TYPE "public"."repository_update_status" AS ENUM('pending', 'syncing', 'indexing', 'indexed', 'failed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."repository_update_trigger" AS ENUM('connect', 'push', 'pull_request', 'reconcile', 'manual', 'default_branch');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('received', 'processed', 'ignored', 'failed');--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "github_installation_status" DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installationId_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "github_repositories" (
	"repository_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"private" boolean NOT NULL,
	"access_removed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"trigger" "repository_update_trigger" NOT NULL,
	"ref" text NOT NULL,
	"target_sha" text,
	"indexed_sha" text,
	"status" "repository_update_status" NOT NULL,
	"snapshot_id" text,
	"patch_analysis_id" text,
	"pull_request" jsonb,
	"delivery_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"coalesced" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"requested_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_guid" text NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"installation_id" bigint,
	"workspace_id" text,
	"repository_id" text,
	"status" "webhook_delivery_status" NOT NULL,
	"reason" text,
	"summary" jsonb NOT NULL,
	"outcome" jsonb,
	"error" jsonb,
	"attempts" integer DEFAULT 1 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_deliveryGuid_unique" UNIQUE("delivery_guid")
);
--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_updates" ADD CONSTRAINT "repository_updates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_updates" ADD CONSTRAINT "repository_updates_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_updates" ADD CONSTRAINT "repository_updates_snapshot_id_repository_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."repository_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_updates" ADD CONSTRAINT "repository_updates_patch_analysis_id_patch_analyses_id_fk" FOREIGN KEY ("patch_analysis_id") REFERENCES "public"."patch_analyses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_updates" ADD CONSTRAINT "repository_updates_delivery_id_webhook_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_installations_workspace_id_index" ON "github_installations" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_repositories_installation_id_github_repository_id_index" ON "github_repositories" USING btree ("installation_id","github_repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_updates_one_pending_per_ref" ON "repository_updates" USING btree ("repository_id","ref") WHERE "repository_updates"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "repository_updates_repository_id_created_at_index" ON "repository_updates" USING btree ("repository_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_workspace_id_received_at_index" ON "webhook_deliveries" USING btree ("workspace_id","received_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_repository_id_received_at_index" ON "webhook_deliveries" USING btree ("repository_id","received_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_next_attempt_at_index" ON "webhook_deliveries" USING btree ("status","next_attempt_at");