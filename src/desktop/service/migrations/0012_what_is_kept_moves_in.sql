CREATE TABLE "guard" (
	"user_id" text PRIMARY KEY NOT NULL,
	"off_digest" text,
	"off_set_at" timestamp with time zone,
	"proof_session" text,
	"proof_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "throttle" (
	"key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "signal_to_idx";--> statement-breakpoint
ALTER TABLE "address" ALTER COLUMN "until" SET DATA TYPE timestamp with time zone USING "until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "address" ALTER COLUMN "released_at" SET DATA TYPE timestamp with time zone USING "released_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "address" ALTER COLUMN "lapsed_at" SET DATA TYPE timestamp with time zone USING "lapsed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "address" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "address" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "blob" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "blob" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "server_board" ALTER COLUMN "gone_at" SET DATA TYPE timestamp with time zone USING "gone_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "server_board" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "server_board" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "change" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "change" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "cut" ALTER COLUMN "time" SET DATA TYPE timestamp with time zone USING "time" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "cut" ALTER COLUMN "time" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "server_guest" ALTER COLUMN "token_until" SET DATA TYPE timestamp with time zone USING "token_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "server_member" ALTER COLUMN "added_at" SET DATA TYPE timestamp with time zone USING "added_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "server_member" ALTER COLUMN "added_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "read_at" SET DATA TYPE timestamp with time zone USING "read_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "repo" ALTER COLUMN "started_at" SET DATA TYPE timestamp with time zone USING "started_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "repo" ALTER COLUMN "started_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "repo" ALTER COLUMN "off_at" SET DATA TYPE timestamp with time zone USING "off_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "repo" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "repo" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "repo_public" ALTER COLUMN "released_at" SET DATA TYPE timestamp with time zone USING "released_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "repo_share" ALTER COLUMN "shared_at" SET DATA TYPE timestamp with time zone USING "shared_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "repo_share" ALTER COLUMN "shared_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "server" ALTER COLUMN "gone_at" SET DATA TYPE timestamp with time zone USING "gone_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "server" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "server" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "signal" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "signal" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "server_board" ADD COLUMN "reach" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "change" ADD COLUMN "reviews" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "server_guest" ADD COLUMN "code_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "made_by" text;--> statement-breakpoint
ALTER TABLE "guard" ADD CONSTRAINT "guard_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "throttle_key_idx" ON "throttle" USING btree ("key","at");--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_made_by_user_id_fk" FOREIGN KEY ("made_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_board_gone_idx" ON "server_board" USING btree ("gone_at") WHERE "server_board"."gone_at" is not null;--> statement-breakpoint
CREATE INDEX "contact_peer_idx" ON "contact" USING btree ("peer");--> statement-breakpoint
CREATE INDEX "message_read_idx" ON "message" USING btree ("created_at") WHERE "message"."read_at" is not null;--> statement-breakpoint
CREATE INDEX "repo_public_server_idx" ON "repo_public" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "server_made_idx" ON "server" USING btree ("made_by","created_at");--> statement-breakpoint
CREATE INDEX "server_gone_idx" ON "server" USING btree ("gone_by","gone_at") WHERE "server"."gone_at" is not null;--> statement-breakpoint
CREATE INDEX "signal_from_idx" ON "signal" USING btree ("from_user","created_at");--> statement-breakpoint
CREATE INDEX "signal_time_idx" ON "signal" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "server_post_user_idx" ON "server_post" USING btree ("user_id","id") WHERE "server_post"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "server_post_guest_idx" ON "server_post" USING btree ("guest_id","id") WHERE "server_post"."guest_id" is not null;--> statement-breakpoint
CREATE INDEX "signal_to_idx" ON "signal" USING btree ("to_user","from_user","created_at");--> statement-breakpoint
-- Data: what lived in a table of its own moves in beside what it belongs to.
-- The code to turn a repo off, and the latest passkey sign-in of each account.
INSERT INTO "guard" ("user_id", "off_digest", "off_set_at")
  SELECT "user_id", "digest", "set_at" AT TIME ZONE 'UTC' FROM "off_code";--> statement-breakpoint
INSERT INTO "guard" ("user_id", "proof_session", "proof_at")
  SELECT DISTINCT ON ("user_id") "user_id", "session_id", "at" AT TIME ZONE 'UTC' FROM "passkey_proof" ORDER BY "user_id", "at" DESC
  ON CONFLICT ("user_id") DO UPDATE SET "proof_session" = excluded."proof_session", "proof_at" = excluded."proof_at";--> statement-breakpoint
-- A change's reviews, newest first, as clients read them (time in ms).
UPDATE "change" c SET "reviews" = r."list" FROM (
  SELECT "change", jsonb_agg(jsonb_build_object('version', "version", 'verdict', "verdict", 'note', "note", 'marks', "marks", 'by', "by",
    'time', floor(extract(epoch from "time" AT TIME ZONE 'UTC') * 1000)::bigint) ORDER BY "time" DESC, "id") AS "list"
  FROM "review" GROUP BY "change") r
  WHERE c."id" = r."change";--> statement-breakpoint
-- How far a board reaches. Guests write only where anyone reads: a board that took
-- guests without being open stays its people's (nothing it held is shown to anyone new).
UPDATE "server_board" SET "reach" = CASE WHEN "open" = 1 AND "guests" = 1 THEN 2 WHEN "open" = 1 THEN 1 ELSE 0 END;--> statement-breakpoint
-- A guest's code held ten minutes from when it was sent.
UPDATE "server_guest" SET "code_at" = ("code_until" AT TIME ZONE 'UTC') - interval '10 minutes' WHERE "code_until" IS NOT NULL;--> statement-breakpoint
-- Who made each server: its first person still in it, or whoever it is held for.
UPDATE "server" s SET "made_by" = coalesce(
  (SELECT m."user_id" FROM "server_member" m WHERE m."server_id" = s."id" ORDER BY m."added_at", m."user_id" LIMIT 1),
  (SELECT u."id" FROM "user" u WHERE u."id" = s."gone_by"));--> statement-breakpoint
-- Names on this Remote made before names had a term: theirs counts from when they were made
-- (what the service did the first time anyone asked; the domains it has run on).
UPDATE "address" SET "until" = "created_at" + interval '5 years' WHERE "until" IS NULL AND "domain" IN ('length3.com', 'length3.test');--> statement-breakpoint
-- A server's name is the address naming it: one per server, and none for a server that is no more.
DELETE FROM "address" a WHERE a."server_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "server" s WHERE s."id" = a."server_id");--> statement-breakpoint
DELETE FROM "address" a USING "server" s WHERE a."server_id" = s."id" AND a."address" <> s."address"
  AND EXISTS (SELECT 1 FROM "address" b WHERE b."server_id" = s."id" AND b."address" = s."address");--> statement-breakpoint
DELETE FROM "address" a USING "address" b WHERE a."server_id" = b."server_id" AND (a."created_at", a."address") < (b."created_at", b."address");--> statement-breakpoint
-- Every server has its code from when it is made: those made before, now.
DO $$
DECLARE s record; c text;
BEGIN
  FOR s IN SELECT "id" FROM "server" WHERE "id" NOT IN (SELECT "server_id" FROM "principal_code" WHERE "server_id" IS NOT NULL) LOOP
    LOOP
      c := (100000 + floor(random() * 900000))::int::text;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "principal_code" WHERE "code" = c);
    END LOOP;
    INSERT INTO "principal_code" ("code", "server_id") VALUES (c, s."id");
  END LOOP;
END $$;
