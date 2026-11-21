CREATE TABLE "time_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"date" date NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_blocks_span_check" CHECK ("time_blocks"."start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "time_blocks"."end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "time_blocks"."start_time" < "time_blocks"."end_time")
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid,
	"source" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"minutes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entries_minutes_check" CHECK ("time_entries"."minutes" is null or "time_entries"."minutes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "estimate_minutes" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "actual_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "first_due_date" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "work_hours" jsonb;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD CONSTRAINT "time_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD CONSTRAINT "time_blocks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD CONSTRAINT "time_blocks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_blocks_user_date_idx" ON "time_blocks" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "time_blocks_task_idx" ON "time_blocks" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "time_entries_task_idx" ON "time_entries" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "time_entries_user_idx" ON "time_entries" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "time_entries_one_running_idx" ON "time_entries" USING btree ("user_id") WHERE "time_entries"."ended_at" is null;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_estimate_check" CHECK ("tasks"."estimate_minutes" is null or "tasks"."estimate_minutes" between 1 and 1440);--> statement-breakpoint
-- The first due date each task had: the earliest "from" of a due-date change in its activity, else today's due date.
UPDATE "tasks" t SET "first_due_date" = coalesce(
	(SELECT (a."data"->'changes'->'dueDate'->>'from')::date FROM "activity" a
	 WHERE a."task_id" = t."id" AND a."workspace_id" = t."workspace_id"
	   AND a."data"->'changes'->'dueDate'->>'from' ~ '^\d{4}-\d{2}-\d{2}$'
	 ORDER BY a."created_at" ASC LIMIT 1),
	t."due_date"
);
