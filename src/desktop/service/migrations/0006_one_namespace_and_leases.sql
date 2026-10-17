ALTER TABLE "address" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "address" ADD COLUMN "server_id" text;--> statement-breakpoint
ALTER TABLE "address" ADD COLUMN "released_at" timestamp;--> statement-breakpoint
ALTER TABLE "address" ADD COLUMN "lapsed_at" timestamp;--> statement-breakpoint
ALTER TABLE "server_guest" ADD COLUMN "token_until" timestamp;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "address" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "gone_at" timestamp;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "gone_by" text;--> statement-breakpoint
CREATE INDEX "address_server_idx" ON "address" USING btree ("server_id");