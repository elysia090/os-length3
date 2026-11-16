-- Who left a server or was removed from it, and when (servers.ts): an invitation sent before then no longer takes
-- them back in when they accept its sender again (inbox.ts). Expand only.
CREATE TABLE "server_left" (
	"server_id" text NOT NULL,
	"user_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_left_server_id_user_id_pk" PRIMARY KEY("server_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "server_left" ADD CONSTRAINT "server_left_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_left" ADD CONSTRAINT "server_left_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;