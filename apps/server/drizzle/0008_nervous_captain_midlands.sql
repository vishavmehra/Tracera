CREATE TYPE "public"."integration_provider" AS ENUM('google');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('active', 'expired', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."meeting_candidate_kind" AS ENUM('bug', 'feature_request', 'question', 'other');--> statement-breakpoint
CREATE TYPE "public"."meeting_candidate_status" AS ENUM('pending_review', 'confirmed', 'dismissed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."meeting_provider" AS ENUM('teams', 'google_meet', 'other');--> statement-breakpoint
CREATE TYPE "public"."meeting_source" AS ENUM('upload_transcript', 'provider_api');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('transcribed', 'processing', 'extracted', 'reviewed', 'failed');--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"status" "integration_status" NOT NULL,
	"scopes" text[] NOT NULL,
	"access_token_sealed" text NOT NULL,
	"refresh_token_sealed" text,
	"access_token_expires_at" timestamp with time zone,
	"last_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"meeting_session_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" "meeting_candidate_kind" NOT NULL,
	"status" "meeting_candidate_status" NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"expected_behavior" text,
	"actual_behavior" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"severity" "severity" DEFAULT 'unknown' NOT NULL,
	"affected_area" text,
	"citations" jsonb NOT NULL,
	"support" jsonb NOT NULL,
	"duplicate_of" jsonb,
	"field_sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"repository_id" text,
	"model_execution_id" text,
	"bug_report_id" text,
	"review" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" "meeting_provider" NOT NULL,
	"source" "meeting_source" NOT NULL,
	"status" "meeting_status" NOT NULL,
	"title" text,
	"occurred_at" timestamp with time zone,
	"repository_id" text,
	"provider_ref" text,
	"integration_connection_id" text,
	"blob_sha256" text NOT NULL,
	"transcript" jsonb NOT NULL,
	"speaker_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"extraction" jsonb,
	"extraction_started_at" timestamp with time zone,
	"failure" jsonb,
	"consent_statement" text NOT NULL,
	"consent_attested_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"segment_index" integer NOT NULL,
	"speaker_label" text,
	"start_ms" integer,
	"end_ms" integer,
	"text" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_candidates" ADD CONSTRAINT "meeting_candidates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_candidates" ADD CONSTRAINT "meeting_candidates_meeting_session_id_meeting_sessions_id_fk" FOREIGN KEY ("meeting_session_id") REFERENCES "public"."meeting_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_candidates" ADD CONSTRAINT "meeting_candidates_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_candidates" ADD CONSTRAINT "meeting_candidates_bug_report_id_bug_reports_id_fk" FOREIGN KEY ("bug_report_id") REFERENCES "public"."bug_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD CONSTRAINT "meeting_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD CONSTRAINT "meeting_sessions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD CONSTRAINT "meeting_sessions_integration_connection_id_integration_connections_id_fk" FOREIGN KEY ("integration_connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD CONSTRAINT "meeting_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_meeting_session_id_meeting_sessions_id_fk" FOREIGN KEY ("meeting_session_id") REFERENCES "public"."meeting_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_workspace_id_user_id_provider_index" ON "integration_connections" USING btree ("workspace_id","user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_candidates_meeting_session_id_ordinal_index" ON "meeting_candidates" USING btree ("meeting_session_id","ordinal");--> statement-breakpoint
CREATE INDEX "meeting_candidates_workspace_id_kind_status_index" ON "meeting_candidates" USING btree ("workspace_id","kind","status");--> statement-breakpoint
CREATE INDEX "meeting_sessions_workspace_id_created_at_id_index" ON "meeting_sessions" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_sessions_workspace_id_provider_ref_index" ON "meeting_sessions" USING btree ("workspace_id","provider_ref") WHERE "meeting_sessions"."provider_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_segments_meeting_session_id_segment_index_index" ON "transcript_segments" USING btree ("meeting_session_id","segment_index");