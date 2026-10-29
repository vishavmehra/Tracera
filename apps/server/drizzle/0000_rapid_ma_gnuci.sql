CREATE TYPE "public"."actor_type" AS ENUM('user', 'api_token', 'mcp', 'worker', 'system');--> statement-breakpoint
CREATE TYPE "public"."bug_report_status" AS ENUM('draft', 'open', 'investigating', 'resolved', 'closed', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."client_kind" AS ENUM('extension', 'mcp', 'script');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('screenshot', 'screen_recording', 'meeting_transcript', 'meeting_recording', 'console_log', 'network_log', 'stack_trace', 'log_file', 'text_note', 'repro_trace', 'repro_screenshot', 'test_output', 'sandbox_log', 'ai_annotation');--> statement-breakpoint
CREATE TYPE "public"."evidence_origin" AS ENUM('user_provided', 'captured_by_extension', 'imported_from_provider', 'generated_by_tool', 'generated_by_model');--> statement-breakpoint
CREATE TYPE "public"."investigation_mode" AS ENUM('full', 'analysis_only');--> statement-breakpoint
CREATE TYPE "public"."investigation_stage" AS ENUM('normalize', 'collect_context', 'plan_reproduction', 'reproduce_baseline', 'generate_hypotheses', 'rank_hypotheses', 'generate_patch', 'verify', 'write_report');--> statement-breakpoint
CREATE TYPE "public"."investigation_status" AS ENUM('queued', 'running', 'needs_input', 'awaiting_approval', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."model_execution_status" AS ENUM('succeeded', 'failed', 'invalid_output', 'cancelled', 'budget_exceeded');--> statement-breakpoint
CREATE TYPE "public"."model_profile" AS ENUM('standard', 'deep');--> statement-breakpoint
CREATE TYPE "public"."normalization_status" AS ENUM('not_requested', 'queued', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('p0', 'p1', 'p2', 'p3', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."repository_source_type" AS ENUM('fixture', 'local_path', 'git_url');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'high', 'medium', 'low', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."source_channel" AS ENUM('web', 'extension', 'meeting', 'mcp', 'api');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped', 'blocked', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"client_kind" "client_kind" NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bug_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_id" text,
	"status" "bug_report_status" DEFAULT 'open' NOT NULL,
	"source_channel" "source_channel" NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"expected_behavior" text,
	"actual_behavior" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"environment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"affected_url" text,
	"severity" "severity" DEFAULT 'unknown' NOT NULL,
	"priority" "priority" DEFAULT 'unknown' NOT NULL,
	"field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"suspected_components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unresolved_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"normalization_status" "normalization_status" DEFAULT 'not_requested' NOT NULL,
	"normalized_at" timestamp with time zone,
	"normalization_result" jsonb,
	"normalization_error" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"bug_report_id" text,
	"investigation_id" text,
	"derived_from_evidence_id" text,
	"kind" "evidence_kind" NOT NULL,
	"origin" "evidence_origin" NOT NULL,
	"blob_sha256" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"original_filename" text,
	"captured_at" timestamp with time zone,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"redactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sensitivity" text[] DEFAULT '{}'::text[] NOT NULL,
	"retention_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_single_owner" CHECK (("evidence_assets"."bug_report_id" is not null)::int + ("evidence_assets"."investigation_id" is not null)::int = 1)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"workspace_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"key" text NOT NULL,
	"method_path" text NOT NULL,
	"request_sha256" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_workspace_id_actor_id_key_pk" PRIMARY KEY("workspace_id","actor_id","key")
);
--> statement-breakpoint
CREATE TABLE "investigation_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"investigation_id" text NOT NULL,
	"stage" "investigation_stage" NOT NULL,
	"attempt" integer NOT NULL,
	"status" "step_status" NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investigations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"bug_report_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"status" "investigation_status" DEFAULT 'queued' NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"current_stage" "investigation_stage",
	"mode" "investigation_mode" NOT NULL,
	"mode_reason" text,
	"model_profile" "model_profile" DEFAULT 'standard' NOT NULL,
	"interactive" boolean DEFAULT true NOT NULL,
	"progress" jsonb NOT NULL,
	"needs_input" jsonb,
	"config_snapshot" jsonb NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"failure" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"investigation_id" text,
	"bug_report_id" text,
	"task" text NOT NULL,
	"prompt_version" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "model_execution_status" NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"redaction_count" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"source_type" "repository_source_type" NOT NULL,
	"source_ref" text NOT NULL,
	"default_branch" text NOT NULL,
	"synthetic" boolean DEFAULT false NOT NULL,
	"commands" jsonb NOT NULL,
	"app" jsonb,
	"allow_install_scripts" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "workspace_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_assets" ADD CONSTRAINT "evidence_assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_assets" ADD CONSTRAINT "evidence_assets_bug_report_id_bug_reports_id_fk" FOREIGN KEY ("bug_report_id") REFERENCES "public"."bug_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_assets" ADD CONSTRAINT "evidence_assets_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_steps" ADD CONSTRAINT "investigation_steps_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_bug_report_id_bug_reports_id_fk" FOREIGN KEY ("bug_report_id") REFERENCES "public"."bug_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_executions" ADD CONSTRAINT "model_executions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_executions" ADD CONSTRAINT "model_executions_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_executions" ADD CONSTRAINT "model_executions_bug_report_id_bug_reports_id_fk" FOREIGN KEY ("bug_report_id") REFERENCES "public"."bug_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_workspace_id_created_at_index" ON "audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_target_type_target_id_index" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "bug_reports_workspace_id_created_at_id_index" ON "bug_reports" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "evidence_assets_bug_report_id_index" ON "evidence_assets" USING btree ("bug_report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_steps_investigation_id_stage_attempt_index" ON "investigation_steps" USING btree ("investigation_id","stage","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "investigations_one_active_per_bug_report" ON "investigations" USING btree ("bug_report_id") WHERE "investigations"."status" in ('queued', 'running', 'needs_input', 'awaiting_approval');--> statement-breakpoint
CREATE INDEX "investigations_workspace_id_created_at_id_index" ON "investigations" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "model_executions_workspace_id_created_at_index" ON "model_executions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_workspace_id_name_index" ON "repositories" USING btree ("workspace_id","name");