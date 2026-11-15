CREATE TABLE "ssh" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"port" integer NOT NULL,
	"destinations" jsonb NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ssh_port" CHECK ("ssh"."port" between 1 and 65535),
	CONSTRAINT "ssh_destinations" CHECK (jsonb_typeof("ssh"."destinations") = 'array' and jsonb_array_length("ssh"."destinations") <= 200 and octet_length("ssh"."destinations"::text) <= 32768)
);
--> statement-breakpoint
ALTER TABLE "ssh" ADD CONSTRAINT "ssh_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh" ADD CONSTRAINT "ssh_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ssh_user_idx" ON "ssh" USING btree ("user_id","since");--> statement-breakpoint
ALTER TABLE "address" DROP COLUMN "ssh";