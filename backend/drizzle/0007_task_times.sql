ALTER TABLE "tasks" ADD COLUMN "start_time" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "due_time" text;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "remind_minutes" smallint DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_start_time_check" CHECK ("tasks"."start_time" is null or ("tasks"."start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "tasks"."start_date" is not null));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_due_time_check" CHECK ("tasks"."due_time" is null or ("tasks"."due_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "tasks"."due_date" is not null));