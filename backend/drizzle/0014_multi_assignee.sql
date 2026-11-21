ALTER TABLE "task_trash" DROP CONSTRAINT "task_trash_assignee_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_assignee_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "tasks_assignee_idx";--> statement-breakpoint
ALTER TABLE "task_trash" ADD COLUMN "assignee_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assignee_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_assignees_idx" ON "tasks" USING gin ("assignee_ids");--> statement-breakpoint
UPDATE "tasks" SET "assignee_ids" = ARRAY["assignee_id"] WHERE "assignee_id" IS NOT NULL;--> statement-breakpoint
UPDATE "task_trash" SET "assignee_ids" = ARRAY["assignee_id"] WHERE "assignee_id" IS NOT NULL;--> statement-breakpoint
UPDATE "task_trash" SET "task" = ("task" - 'assigneeId') || jsonb_build_object('assigneeIds', to_jsonb("assignee_ids"));--> statement-breakpoint
ALTER TABLE "task_trash" DROP COLUMN "assignee_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "assignee_id";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignees_check" CHECK (cardinality("tasks"."assignee_ids") <= 20);