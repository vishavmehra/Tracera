CREATE TYPE "public"."authorized_action_kind" AS ENUM('apply', 'commit', 'push');--> statement-breakpoint
CREATE TYPE "public"."authorized_action_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'refused');--> statement-breakpoint
CREATE TABLE "authorized_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"patch_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"kind" "authorized_action_kind" NOT NULL,
	"status" "authorized_action_status" NOT NULL,
	"requested_by" text NOT NULL,
	"acknowledged_outcome" "verification_outcome",
	"acknowledged_risks" boolean DEFAULT false NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "authorized_actions" ADD CONSTRAINT "authorized_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorized_actions" ADD CONSTRAINT "authorized_actions_patch_id_patch_proposals_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patch_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorized_actions" ADD CONSTRAINT "authorized_actions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorized_actions" ADD CONSTRAINT "authorized_actions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "authorized_actions_one_running_per_repository" ON "authorized_actions" USING btree ("repository_id") WHERE "authorized_actions"."status" = 'running';--> statement-breakpoint
CREATE INDEX "authorized_actions_patch_id_created_at_index" ON "authorized_actions" USING btree ("patch_id","created_at");