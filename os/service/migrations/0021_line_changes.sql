CREATE TABLE "line_change" (
	"repo_id" bigint NOT NULL,
	"line" text NOT NULL,
	"version" integer NOT NULL,
	"set" jsonb NOT NULL,
	"gone" jsonb NOT NULL,
	CONSTRAINT "line_change_repo_id_line_version_pk" PRIMARY KEY("repo_id","line","version"),
	CONSTRAINT "line_change_set" CHECK (jsonb_typeof("line_change"."set") = 'object'),
	CONSTRAINT "line_change_gone" CHECK (jsonb_typeof("line_change"."gone") = 'array')
);
--> statement-breakpoint
ALTER TABLE "line_change" ADD CONSTRAINT "line_change_line" FOREIGN KEY ("repo_id","line") REFERENCES "public"."line"("repo_id","name") ON DELETE cascade ON UPDATE cascade;