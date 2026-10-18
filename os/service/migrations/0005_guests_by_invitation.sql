-- A guest is let in by an invitation one of a board's people hands them,
-- not by an email address: nothing is mailed, and no address is kept. No
-- Remote ever sent a guest's code (none was given a way to send mail), so
-- no guest can be here; any that is goes before its columns change.
DELETE FROM "board_guest";--> statement-breakpoint
CREATE TABLE "board_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"server_id" text NOT NULL,
	"user_id" text NOT NULL,
	"digest" text NOT NULL,
	"uses" smallint NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_invite_id" CHECK (id ~ '^[0-9a-z]{12}$'),
	CONSTRAINT "board_invite_digest" CHECK (digest ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "board_invite_uses" CHECK ("board_invite"."uses" between 0 and 20)
);
--> statement-breakpoint
ALTER TABLE "board_guest" DROP CONSTRAINT "board_guest_email";--> statement-breakpoint
ALTER TABLE "board_guest" DROP CONSTRAINT "board_guest_digests";--> statement-breakpoint
ALTER TABLE "board_guest" DROP CONSTRAINT "board_guest_tries";--> statement-breakpoint
DROP INDEX "board_guest_email_idx";--> statement-breakpoint
ALTER TABLE "board_guest" ALTER COLUMN "token" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "board_guest" ALTER COLUMN "token_until" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "board_invite" ADD CONSTRAINT "board_invite_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_invite" ADD CONSTRAINT "board_invite_member" FOREIGN KEY ("server_id","user_id") REFERENCES "public"."server_member"("server_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_invite_digest_idx" ON "board_invite" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "board_invite_board_idx" ON "board_invite" USING btree ("board_id","created_at");--> statement-breakpoint
ALTER TABLE "board_guest" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "board_guest" DROP COLUMN "code";--> statement-breakpoint
ALTER TABLE "board_guest" DROP COLUMN "code_at";--> statement-breakpoint
ALTER TABLE "board_guest" DROP COLUMN "tries";--> statement-breakpoint
ALTER TABLE "board_guest" ADD CONSTRAINT "board_guest_token" CHECK (token ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "board_guest" ADD COLUMN "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "board_guest" ADD COLUMN "invited_by" text;--> statement-breakpoint
ALTER TABLE "board_guest" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "board_guest" ADD CONSTRAINT "board_guest_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_guest_name_idx" ON "board_guest" USING btree ("board_id",lower("name"));--> statement-breakpoint
ALTER TABLE "board_guest" ADD CONSTRAINT "board_guest_name" CHECK (char_length(name) between 1 and 32 and position('@' in name) = 0);
