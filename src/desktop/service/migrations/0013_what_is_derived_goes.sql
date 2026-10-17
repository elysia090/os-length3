DROP TABLE "off_code" CASCADE;--> statement-breakpoint
DROP TABLE "passkey_proof" CASCADE;--> statement-breakpoint
DROP TABLE "review" CASCADE;--> statement-breakpoint
DROP INDEX "address_server_idx";--> statement-breakpoint
DROP INDEX "cut_repo_idx";--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "address_server_idx" ON "address" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "cut_repo_idx" ON "cut" USING btree ("user_id","repo");--> statement-breakpoint
ALTER TABLE "server_board" DROP COLUMN "open";--> statement-breakpoint
ALTER TABLE "server_board" DROP COLUMN "guests";--> statement-breakpoint
ALTER TABLE "change" DROP COLUMN "issue";--> statement-breakpoint
ALTER TABLE "change" DROP COLUMN "merged_cut";--> statement-breakpoint
ALTER TABLE "change" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "contact" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "cut" DROP COLUMN "line";--> statement-breakpoint
ALTER TABLE "server_guest" DROP COLUMN "code_until";--> statement-breakpoint
ALTER TABLE "server_guest" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "home" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "server_member" DROP COLUMN "address";--> statement-breakpoint
ALTER TABLE "principal_code" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "repo" DROP COLUMN "issue";--> statement-breakpoint
ALTER TABLE "repo" DROP COLUMN "draft_base";--> statement-breakpoint
ALTER TABLE "repo" DROP COLUMN "bytes";--> statement-breakpoint
ALTER TABLE "repo" DROP COLUMN "changed_by";--> statement-breakpoint
ALTER TABLE "repo_public" DROP COLUMN "published_at";--> statement-breakpoint
ALTER TABLE "server" DROP COLUMN "address";--> statement-breakpoint
ALTER TABLE "server_todo" DROP COLUMN "updated_at";