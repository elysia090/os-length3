CREATE TABLE "server_todo" (
	"board_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text,
	"title" text DEFAULT '' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"place" double precision DEFAULT 0 NOT NULL,
	"by" text NOT NULL,
	"created" bigint NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "server_todo_board_id_id_pk" PRIMARY KEY("board_id","id")
);
--> statement-breakpoint
ALTER TABLE "server_todo" ADD CONSTRAINT "server_todo_board_id_server_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."server_board"("id") ON DELETE cascade ON UPDATE no action;