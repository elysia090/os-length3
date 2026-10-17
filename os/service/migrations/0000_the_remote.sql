CREATE TABLE "address" (
	"address" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"server_id" text,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"ssh" boolean DEFAULT false NOT NULL,
	"until" timestamp with time zone,
	"released_at" timestamp with time zone,
	"lapsed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "address_whose" CHECK (num_nonnulls("address"."user_id", "address"."server_id") = 1),
	CONSTRAINT "address_parts" CHECK (address = name || '@' || domain and name ~ '^[a-z0-9][a-z0-9._-]{1,30}$' and char_length(domain) between 3 and 253)
);
--> statement-breakpoint
CREATE TABLE "blob" (
	"user_id" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_user_id_sha256_pk" PRIMARY KEY("user_id","sha256"),
	CONSTRAINT "blob_sha" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "blob_bytes" CHECK ("blob"."bytes" between 0 and 16777216)
);
--> statement-breakpoint
CREATE TABLE "board" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"name" text NOT NULL,
	"reach" smallint DEFAULT 0 NOT NULL,
	"gone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_id" CHECK (id ~ '^[0-9a-z]{12}$'),
	CONSTRAINT "board_name" CHECK (char_length("board"."name") between 1 and 64),
	CONSTRAINT "board_reach" CHECK ("board"."reach" between 0 and 2)
);
--> statement-breakpoint
CREATE TABLE "change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"line" text NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"base" text,
	"head" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"submitted_by" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_state" CHECK ("change"."state" in ('open', 'merged', 'rejected', 'reset')),
	CONSTRAINT "change_line" CHECK (line ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
	CONSTRAINT "change_words" CHECK (char_length(kind) <= 2000 and char_length(title) between 1 and 2000 and char_length(note) <= 2000 and char_length(submitted_by) <= 200),
	CONSTRAINT "change_version" CHECK ("change"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"user_id" text NOT NULL,
	"peer" text NOT NULL,
	"state" text NOT NULL,
	CONSTRAINT "contact_user_id_peer_pk" PRIMARY KEY("user_id","peer"),
	CONSTRAINT "contact_state" CHECK ("contact"."state" in ('accepted', 'blocked')),
	CONSTRAINT "contact_other" CHECK ("contact"."user_id" <> "contact"."peer")
);
--> statement-breakpoint
CREATE TABLE "cut" (
	"repo_id" bigint NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"parent" text,
	"merged" text,
	"tree" jsonb NOT NULL,
	"bytes" integer GENERATED ALWAYS AS (octet_length(tree::text)) STORED NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"issue" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"time" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cut_repo_id_id_pk" PRIMARY KEY("repo_id","id"),
	CONSTRAINT "cut_id" CHECK (id ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cut_tree" CHECK (jsonb_typeof("cut"."tree") = 'object'),
	CONSTRAINT "cut_words" CHECK (char_length(kind) <= 2000 and char_length(title) between 1 and 2000 and char_length(issue) <= 2000 and char_length(note) <= 2000),
	CONSTRAINT "cut_counts" CHECK ("cut"."added" >= 0 and "cut"."removed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guard" (
	"user_id" text PRIMARY KEY NOT NULL,
	"off_digest" text,
	"off_set_at" timestamp with time zone,
	"proof_session" text,
	"proof_at" timestamp with time zone,
	CONSTRAINT "guard_digest" CHECK (off_digest is null or off_digest ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "board_guest" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"email" text NOT NULL,
	"code" text,
	"code_at" timestamp with time zone,
	"tries" smallint DEFAULT 0 NOT NULL,
	"token" text,
	"token_until" timestamp with time zone,
	CONSTRAINT "board_guest_id" CHECK (id ~ '^[0-9a-z]{12}$'),
	CONSTRAINT "board_guest_email" CHECK (char_length("board_guest"."email") <= 260),
	CONSTRAINT "board_guest_digests" CHECK ((code is null or code ~ '^[0-9a-f]{64}$') and (token is null or token ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "board_guest_tries" CHECK ("board_guest"."tries" >= 0)
);
--> statement-breakpoint
CREATE TABLE "home" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "home_user_id_key_pk" PRIMARY KEY("user_id","key"),
	CONSTRAINT "home_key" CHECK (key ~ '^[a-z]{1,32}$'),
	CONSTRAINT "home_value" CHECK (char_length(value) <= 1048576),
	CONSTRAINT "home_version" CHECK ("home"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "line" (
	"repo_id" bigint NOT NULL,
	"name" text NOT NULL,
	"user_id" text NOT NULL,
	"base" text,
	"head" text,
	"pushed" text,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bytes" integer GENERATED ALWAYS AS (octet_length(draft::text)) STORED NOT NULL,
	"file_bytes" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"started_by" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "line_repo_id_name_pk" PRIMARY KEY("repo_id","name"),
	CONSTRAINT "line_name" CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
	CONSTRAINT "line_draft" CHECK (jsonb_typeof("line"."draft") = 'object'),
	CONSTRAINT "line_version" CHECK ("line"."version" >= 0),
	CONSTRAINT "line_started_by" CHECK (char_length(started_by) <= 200)
);
--> statement-breakpoint
CREATE TABLE "server_member" (
	"server_id" text NOT NULL,
	"user_id" text NOT NULL,
	"owner" boolean DEFAULT false NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_member_server_id_user_id_pk" PRIMARY KEY("server_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_user" text NOT NULL,
	"from_user" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"type" text DEFAULT 'message' NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "message_type" CHECK ("message"."type" in ('message', 'review', 'question', 'run')),
	CONSTRAINT "message_body" CHECK (char_length("message"."body") between 1 and 4000),
	CONSTRAINT "message_target" CHECK (jsonb_typeof("message"."target") = 'object' and octet_length("message"."target"::text) <= 1024)
);
--> statement-breakpoint
CREATE TABLE "principal_code" (
	"code" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"server_id" text,
	CONSTRAINT "principal_code_digits" CHECK (code ~ '^[1-9][0-9]{5}$'),
	CONSTRAINT "principal_code_whose" CHECK (num_nonnulls("principal_code"."user_id", "principal_code"."server_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "repo" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repo_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"off_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_user_name" UNIQUE("user_id","name"),
	CONSTRAINT "repo_owner" UNIQUE("id","user_id"),
	CONSTRAINT "repo_name" CHECK (name ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$' and name <> 'gone')
);
--> statement-breakpoint
CREATE TABLE "repo_gone" (
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_gone_user_id_name_pk" PRIMARY KEY("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "repo_public" (
	"face" text NOT NULL,
	"name" text NOT NULL,
	"repo_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"server_id" text,
	"released_at" timestamp with time zone,
	CONSTRAINT "repo_public_face_name_pk" PRIMARY KEY("face","name"),
	CONSTRAINT "repo_public_name" CHECK (name ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "repo_share" (
	"repo_id" bigint NOT NULL,
	"server_id" text NOT NULL,
	"user_id" text NOT NULL,
	"shared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_share_repo_id_server_id_pk" PRIMARY KEY("repo_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"verdict" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"marks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bytes" integer GENERATED ALWAYS AS (octet_length(note) + octet_length(marks::text)) STORED NOT NULL,
	"by" text NOT NULL,
	"time" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_verdict" CHECK ("review"."verdict" in ('approve', 'changes', 'comment')),
	CONSTRAINT "review_note" CHECK (char_length(note) <= 2000),
	CONSTRAINT "review_marks" CHECK (jsonb_typeof("review"."marks") = 'array' and jsonb_array_length("review"."marks") <= 200 and octet_length("review"."marks"::text) <= 40000)
);
--> statement-breakpoint
CREATE TABLE "room" (
	"user_id" text PRIMARY KEY NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"stamp" bigint DEFAULT 0 NOT NULL,
	"unswept" boolean DEFAULT false NOT NULL,
	CONSTRAINT "room_used" CHECK ("room"."used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "server" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"made_by" text,
	"gone_at" timestamp with time zone,
	"gone_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_id" CHECK (id ~ '^[0-9a-z]{12}$'),
	CONSTRAINT "server_name" CHECK (char_length("server"."name") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_user" text NOT NULL,
	"from_user" text NOT NULL,
	"session" text NOT NULL,
	"kind" text NOT NULL,
	"data" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_kind" CHECK ("signal"."kind" in ('offer', 'answer', 'candidate', 'bye')),
	CONSTRAINT "signal_size" CHECK (char_length(session) <= 64 and char_length(data) <= 16384)
);
--> statement-breakpoint
CREATE TABLE "board_post" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"user_id" text,
	"guest_id" text,
	"by" text NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "board_post_id" CHECK (id ~ '^[0-9a-z]{17}$'),
	CONSTRAINT "board_post_body" CHECK (char_length("board_post"."body") between 1 and 2000),
	CONSTRAINT "board_post_whose" CHECK (num_nonnulls("board_post"."user_id", "board_post"."guest_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "throttle" (
	"key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "throttle_key" CHECK (char_length(key) <= 300)
);
--> statement-breakpoint
CREATE TABLE "board_todo" (
	"board_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text,
	"title" text DEFAULT '' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"place" double precision DEFAULT 0 NOT NULL,
	"by" text NOT NULL,
	"created" bigint NOT NULL,
	CONSTRAINT "board_todo_board_id_id_pk" PRIMARY KEY("board_id","id"),
	CONSTRAINT "board_todo_id" CHECK (id ~ '^[0-9a-z-]{1,40}$'),
	CONSTRAINT "board_todo_kind" CHECK (kind is null or kind ~ '^[A-Za-z][A-Za-z0-9-]{0,15}$'),
	CONSTRAINT "board_todo_words" CHECK (char_length(title) <= 200 and char_length(detail) <= 4000),
	CONSTRAINT "board_todo_place" CHECK ("board_todo"."place" > '-Infinity'::float8 and "board_todo"."place" < 'Infinity'::float8)
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_code" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp,
	"polling_interval" integer,
	"client_id" text,
	"scope" text
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob" ADD CONSTRAINT "blob_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board" ADD CONSTRAINT "board_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change" ADD CONSTRAINT "change_repo" FOREIGN KEY ("repo_id","user_id") REFERENCES "public"."repo"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change" ADD CONSTRAINT "change_base" FOREIGN KEY ("repo_id","base") REFERENCES "public"."cut"("repo_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change" ADD CONSTRAINT "change_head" FOREIGN KEY ("repo_id","head") REFERENCES "public"."cut"("repo_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_peer_user_id_fk" FOREIGN KEY ("peer") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cut" ADD CONSTRAINT "cut_repo" FOREIGN KEY ("repo_id","user_id") REFERENCES "public"."repo"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cut" ADD CONSTRAINT "cut_parent" FOREIGN KEY ("repo_id","parent") REFERENCES "public"."cut"("repo_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cut" ADD CONSTRAINT "cut_merged" FOREIGN KEY ("repo_id","merged") REFERENCES "public"."cut"("repo_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guard" ADD CONSTRAINT "guard_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_guest" ADD CONSTRAINT "board_guest_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home" ADD CONSTRAINT "home_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line" ADD CONSTRAINT "line_repo" FOREIGN KEY ("repo_id","user_id") REFERENCES "public"."repo"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line" ADD CONSTRAINT "line_base" FOREIGN KEY ("repo_id","base") REFERENCES "public"."cut"("repo_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line" ADD CONSTRAINT "line_head" FOREIGN KEY ("repo_id","head") REFERENCES "public"."cut"("repo_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line" ADD CONSTRAINT "line_pushed" FOREIGN KEY ("repo_id","pushed") REFERENCES "public"."cut"("repo_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_member" ADD CONSTRAINT "server_member_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_member" ADD CONSTRAINT "server_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_to_user_user_id_fk" FOREIGN KEY ("to_user") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_from_user_user_id_fk" FOREIGN KEY ("from_user") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_code" ADD CONSTRAINT "principal_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_code" ADD CONSTRAINT "principal_code_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo" ADD CONSTRAINT "repo_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_gone" ADD CONSTRAINT "repo_gone_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_public" ADD CONSTRAINT "repo_public_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_public" ADD CONSTRAINT "repo_public_repo" FOREIGN KEY ("repo_id","user_id") REFERENCES "public"."repo"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_share" ADD CONSTRAINT "repo_share_repo" FOREIGN KEY ("repo_id","user_id") REFERENCES "public"."repo"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_share" ADD CONSTRAINT "repo_share_member" FOREIGN KEY ("server_id","user_id") REFERENCES "public"."server_member"("server_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_change_id_change_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."change"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_made_by_user_id_fk" FOREIGN KEY ("made_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_gone_by_user_id_fk" FOREIGN KEY ("gone_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal" ADD CONSTRAINT "signal_to_user_user_id_fk" FOREIGN KEY ("to_user") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal" ADD CONSTRAINT "signal_from_user_user_id_fk" FOREIGN KEY ("from_user") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_post" ADD CONSTRAINT "board_post_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_post" ADD CONSTRAINT "board_post_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_post" ADD CONSTRAINT "board_post_guest_id_board_guest_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."board_guest"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_todo" ADD CONSTRAINT "board_todo_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "address_user_idx" ON "address" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "address_server_idx" ON "address" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "blob_created_idx" ON "blob" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "board_server_idx" ON "board" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "board_gone_idx" ON "board" USING btree ("gone_at") WHERE "board"."gone_at" is not null;--> statement-breakpoint
CREATE INDEX "board_open_idx" ON "board" USING btree ("created_at") WHERE "board"."reach" >= 1 and "board"."gone_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "change_line_idx" ON "change" USING btree ("repo_id","line");--> statement-breakpoint
CREATE INDEX "contact_peer_idx" ON "contact" USING btree ("peer");--> statement-breakpoint
CREATE UNIQUE INDEX "board_guest_email_idx" ON "board_guest" USING btree ("board_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "board_guest_token_idx" ON "board_guest" USING btree ("token");--> statement-breakpoint
CREATE INDEX "line_user_idx" ON "line" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "server_member_user_idx" ON "server_member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "server_member_owner_idx" ON "server_member" USING btree ("server_id") WHERE "server_member"."owner";--> statement-breakpoint
CREATE INDEX "message_to_idx" ON "message" USING btree ("to_user","created_at");--> statement-breakpoint
CREATE INDEX "message_from_idx" ON "message" USING btree ("from_user","created_at");--> statement-breakpoint
CREATE INDEX "message_read_idx" ON "message" USING btree ("created_at") WHERE "message"."read_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "principal_code_user_idx" ON "principal_code" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "principal_code_server_idx" ON "principal_code" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "repo_off_idx" ON "repo" USING btree ("off_at") WHERE "repo"."off_at" is not null;--> statement-breakpoint
CREATE INDEX "repo_gone_at_idx" ON "repo_gone" USING btree ("at");--> statement-breakpoint
CREATE INDEX "repo_public_repo_idx" ON "repo_public" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "repo_public_server_idx" ON "repo_public" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_public_one_idx" ON "repo_public" USING btree ("repo_id") WHERE "repo_public"."released_at" is null;--> statement-breakpoint
CREATE INDEX "repo_share_server_idx" ON "repo_share" USING btree ("server_id","shared_at");--> statement-breakpoint
CREATE INDEX "review_change_idx" ON "review" USING btree ("change_id","time");--> statement-breakpoint
CREATE INDEX "room_unswept_idx" ON "room" USING btree ("user_id") WHERE "room"."unswept";--> statement-breakpoint
CREATE INDEX "server_made_idx" ON "server" USING btree ("made_by","created_at");--> statement-breakpoint
CREATE INDEX "server_gone_idx" ON "server" USING btree ("gone_by","gone_at") WHERE "server"."gone_at" is not null;--> statement-breakpoint
CREATE INDEX "signal_to_idx" ON "signal" USING btree ("to_user","from_user","created_at");--> statement-breakpoint
CREATE INDEX "signal_from_idx" ON "signal" USING btree ("from_user","created_at");--> statement-breakpoint
CREATE INDEX "signal_time_idx" ON "signal" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "board_post_board_idx" ON "board_post" USING btree ("board_id","id");--> statement-breakpoint
CREATE INDEX "board_post_user_idx" ON "board_post" USING btree ("user_id","id") WHERE "board_post"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "board_post_guest_idx" ON "board_post" USING btree ("guest_id","id") WHERE "board_post"."guest_id" is not null;--> statement-breakpoint
CREATE INDEX "throttle_key_idx" ON "throttle" USING btree ("key","at");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_deviceCode_uidx" ON "device_code" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_userCode_uidx" ON "device_code" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");