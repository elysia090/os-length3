DROP TABLE "server_plan_version" CASCADE;--> statement-breakpoint
ALTER TABLE "server_board" DROP COLUMN "plan";--> statement-breakpoint
ALTER TABLE "server_board" DROP COLUMN "version";