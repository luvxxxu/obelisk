ALTER TABLE "users" ADD COLUMN "jev_key" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "jev_key_hint" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "jev_auto_apply" boolean DEFAULT false NOT NULL;