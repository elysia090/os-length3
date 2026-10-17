CREATE TABLE "server_board" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"open" integer DEFAULT 0 NOT NULL,
	"guests" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_guest" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"email" text NOT NULL,
	"code" text,
	"code_until" timestamp,
	"tries" integer DEFAULT 0 NOT NULL,
	"token" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_member" (
	"server_id" text NOT NULL,
	"user_id" text NOT NULL,
	"address" text NOT NULL,
	"owner" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "server_member_server_id_user_id_pk" PRIMARY KEY("server_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "server_plan_version" (
	"board_id" text NOT NULL,
	"version" integer NOT NULL,
	"text" text NOT NULL,
	"by" text NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "server_plan_version_board_id_version_pk" PRIMARY KEY("board_id","version")
);
--> statement-breakpoint
CREATE TABLE "server" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_post" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"user_id" text,
	"guest_id" text,
	"by" text NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_board" ADD CONSTRAINT "server_board_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_guest" ADD CONSTRAINT "server_guest_board_id_server_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."server_board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_member" ADD CONSTRAINT "server_member_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_member" ADD CONSTRAINT "server_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_plan_version" ADD CONSTRAINT "server_plan_version_board_id_server_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."server_board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_post" ADD CONSTRAINT "server_post_board_id_server_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."server_board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_post" ADD CONSTRAINT "server_post_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_board_server_idx" ON "server_board" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "server_guest_board_email_idx" ON "server_guest" USING btree ("board_id","email");--> statement-breakpoint
CREATE INDEX "server_guest_token_idx" ON "server_guest" USING btree ("token");--> statement-breakpoint
CREATE INDEX "server_member_user_idx" ON "server_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "server_post_board_idx" ON "server_post" USING btree ("board_id","id");