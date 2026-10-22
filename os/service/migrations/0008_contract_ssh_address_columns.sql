ALTER TABLE "ssh" DROP CONSTRAINT "ssh_port";--> statement-breakpoint
ALTER TABLE "ssh" DROP CONSTRAINT "ssh_destinations";--> statement-breakpoint
ALTER TABLE "ssh" DROP COLUMN "port";--> statement-breakpoint
ALTER TABLE "ssh" DROP COLUMN "destinations";