CREATE TYPE "public"."confidence" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."evidence_basis" AS ENUM('observed', 'reported', 'inferred');--> statement-breakpoint
CREATE TYPE "public"."hypothesis_state" AS ENUM('proposed', 'supported', 'contradicted', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."patch_status" AS ENUM('proposed', 'apply_failed', 'superseded', 'approved', 'rejected', 'changes_requested');--> statement-breakpoint
CREATE TYPE "public"."sandbox_run_status" AS ENUM('exited', 'timed_out', 'cancelled', 'limit_exceeded', 'executor_error');--> statement-breakpoint
CREATE TYPE "public"."verification_outcome" AS ENUM('verified', 'partially_verified', 'failed', 'inconclusive', 'blocked', 'not_attempted');--> statement-breakpoint
CREATE TABLE "hypotheses" (
	"id" text PRIMARY KEY NOT NULL,
	"investigation_id" text NOT NULL,
	"handle" text NOT NULL,
	"rank" integer NOT NULL,
	"title" text NOT NULL,
	"mechanism" text NOT NULL,
	"locations" jsonb NOT NULL,
	"supporting" jsonb NOT NULL,
	"contradicting" jsonb NOT NULL,
	"alternatives" jsonb NOT NULL,
	"next_check" text NOT NULL,
	"confidence" "confidence" NOT NULL,
	"confidence_rationale" text NOT NULL,
	"state" "hypothesis_state" NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"model_execution_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investigation_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"investigation_id" text NOT NULL,
	"handle" text NOT NULL,
	"kind" text NOT NULL,
	"basis" "evidence_basis" NOT NULL,
	"label" text NOT NULL,
	"content" text NOT NULL,
	"locator" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stage" "investigation_stage" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patch_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"investigation_id" text NOT NULL,
	"hypothesis_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" "patch_status" NOT NULL,
	"base_commit" text NOT NULL,
	"edits" jsonb NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"diff_sha256" text,
	"diff_bytes" integer DEFAULT 0 NOT NULL,
	"summary" text NOT NULL,
	"rationale" text NOT NULL,
	"expected_effect" text NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"apply_error" jsonb,
	"model" jsonb,
	"model_execution_id" text,
	"approval" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolution_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"investigation_id" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"markdown_sha256" text NOT NULL,
	"generated_with" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"investigation_id" text NOT NULL,
	"patch_id" text,
	"run_key" text NOT NULL,
	"purpose" text NOT NULL,
	"argv" text[] NOT NULL,
	"image" text NOT NULL,
	"status" "sandbox_run_status" NOT NULL,
	"exit_code" integer,
	"duration_ms" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"stdout_sha256" text,
	"stderr_sha256" text,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_runs_runKey_unique" UNIQUE("run_key")
);
--> statement-breakpoint
CREATE TABLE "verification_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"investigation_id" text NOT NULL,
	"patch_id" text NOT NULL,
	"status" text NOT NULL,
	"outcome" "verification_outcome" NOT NULL,
	"outcome_reasons" jsonb NOT NULL,
	"checks" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_runs_patchId_unique" UNIQUE("patch_id")
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"sandbox" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_evidence" ADD CONSTRAINT "investigation_evidence_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_proposals" ADD CONSTRAINT "patch_proposals_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_proposals" ADD CONSTRAINT "patch_proposals_hypothesis_id_hypotheses_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."hypotheses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_reports" ADD CONSTRAINT "resolution_reports_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_patch_id_patch_proposals_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patch_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hypotheses_investigation_id_handle_index" ON "hypotheses" USING btree ("investigation_id","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_evidence_investigation_id_handle_index" ON "investigation_evidence" USING btree ("investigation_id","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "patch_proposals_investigation_id_attempt_index" ON "patch_proposals" USING btree ("investigation_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "resolution_reports_investigation_id_version_index" ON "resolution_reports" USING btree ("investigation_id","version");--> statement-breakpoint
CREATE INDEX "sandbox_runs_investigation_id_index" ON "sandbox_runs" USING btree ("investigation_id");