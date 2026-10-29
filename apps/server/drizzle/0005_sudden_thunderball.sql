CREATE TYPE "public"."assessment_kind" AS ENUM('feasibility', 'question');--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "kind" "assessment_kind" DEFAULT 'feasibility' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_parent_id_assessments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."assessments"("id") ON DELETE set null ON UPDATE no action;