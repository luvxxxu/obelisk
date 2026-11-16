ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "task_dependencies" DROP CONSTRAINT "task_dependencies_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "projects_user_idx";--> statement-breakpoint
DROP INDEX "deps_user_idx";--> statement-breakpoint
DROP INDEX "tasks_user_number_idx";--> statement-breakpoint
DROP INDEX "tasks_user_status_idx";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "task_dependencies" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "task_seq";