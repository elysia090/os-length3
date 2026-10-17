CREATE TABLE "repo_public" (
	"face" text NOT NULL,
	"name" text NOT NULL,
	"user_id" text NOT NULL,
	"repo" text NOT NULL,
	"server_id" text,
	"published_at" timestamp DEFAULT now() NOT NULL,
	"released_at" timestamp,
	CONSTRAINT "repo_public_face_name_pk" PRIMARY KEY("face","name")
);
--> statement-breakpoint
CREATE TABLE "repo_share" (
	"user_id" text NOT NULL,
	"repo" text NOT NULL,
	"server_id" text NOT NULL,
	"shared_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "repo_share_user_id_repo_server_id_pk" PRIMARY KEY("user_id","repo","server_id")
);
--> statement-breakpoint
ALTER TABLE "repo_public" ADD CONSTRAINT "repo_public_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_public" ADD CONSTRAINT "repo_public_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_share" ADD CONSTRAINT "repo_share_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_share" ADD CONSTRAINT "repo_share_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repo_public_owner_idx" ON "repo_public" USING btree ("user_id","repo");--> statement-breakpoint
CREATE INDEX "repo_share_server_idx" ON "repo_share" USING btree ("server_id");