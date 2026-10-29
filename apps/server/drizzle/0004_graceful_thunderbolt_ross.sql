ALTER TYPE "public"."snapshot_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "repository_snapshots" ADD COLUMN "progress" jsonb;--> statement-breakpoint
ALTER TABLE "repository_snapshots" ADD COLUMN "cancel_requested_at" timestamp with time zone;