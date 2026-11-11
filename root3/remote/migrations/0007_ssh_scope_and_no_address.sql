ALTER TABLE "ssh" ALTER COLUMN "port" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ssh" ALTER COLUMN "destinations" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "ssh" ALTER COLUMN "destinations" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ssh" ADD COLUMN "scope" text DEFAULT 'device' NOT NULL;--> statement-breakpoint
ALTER TABLE "ssh" ADD CONSTRAINT "ssh_scope" CHECK ("ssh"."scope" in ('device', 'network'));--> statement-breakpoint
-- What devices said of where they are reached goes now. The Worker before this one still reads both columns while
-- this runs (a deploy migrates first), so they stay, empty, until the contract step after it drops them.
UPDATE "ssh" SET "port" = NULL, "destinations" = '[]'::jsonb;