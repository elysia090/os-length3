CREATE TABLE "board_seen" (
	"board_id" text NOT NULL,
	"user_id" text NOT NULL,
	"post" text NOT NULL,
	CONSTRAINT "board_seen_board_id_user_id_pk" PRIMARY KEY("board_id","user_id"),
	CONSTRAINT "board_seen_post" CHECK (post ~ '^[0-9a-z]{17}$')
);
--> statement-breakpoint
ALTER TABLE "board_seen" ADD CONSTRAINT "board_seen_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_seen" ADD CONSTRAINT "board_seen_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_seen_user_idx" ON "board_seen" USING btree ("user_id");