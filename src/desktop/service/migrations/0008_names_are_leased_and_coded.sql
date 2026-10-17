CREATE TABLE "principal_code" (
	"code" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"server_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "address" ADD COLUMN "until" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "principal_code_user_idx" ON "principal_code" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "principal_code_server_idx" ON "principal_code" USING btree ("server_id");