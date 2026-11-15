-- A line's draft was one JSON value, and every save wrote it whole: a repo of 20,000 files, 1.9 MB a keystroke's save,
-- some 90 ms of the database's time and 1.5 MB of its log (what Neon keeps as history), whatever the save changed. It
-- is a row a path now (line_file), and a save writes the rows it changes: what the draft takes (paths, bytes, its files'
-- bytes) is kept beside it as each save changes it (repos.ts), no longer worked out from the whole each time.
--
-- The expand step. The Worker before reads and writes draft until the new one answers: what it writes is laid on the
-- rows here (line_draft_rows), and once the new Worker has changed a line, the Worker before can no more read or write
-- that line's draft (it is null, and a write to it is refused as the database busy: its client tries again, and meets
-- the new Worker). The contract step (0024) drops draft and all this.
CREATE TABLE "line_file" (
	"repo_id" bigint NOT NULL,
	"line" text NOT NULL,
	"path" text COLLATE "C" NOT NULL,
	"sha" text,
	CONSTRAINT "line_file_repo_id_line_path_pk" PRIMARY KEY("repo_id","line","path"),
	CONSTRAINT "line_file_sha" CHECK ("line_file"."sha" is null or "line_file"."sha" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "line_file_path" CHECK (char_length("line_file"."path") between 1 and 1024)
);
--> statement-breakpoint
ALTER TABLE "line" DROP CONSTRAINT "line_draft";--> statement-breakpoint
ALTER TABLE "line" ALTER COLUMN "draft" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "line" ALTER COLUMN "draft" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "line" ALTER COLUMN "bytes" DROP EXPRESSION;--> statement-breakpoint
ALTER TABLE "line" ALTER COLUMN "bytes" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "line" ADD COLUMN "paths" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "line_file" ADD CONSTRAINT "line_file_line" FOREIGN KEY ("repo_id","line") REFERENCES "public"."line"("repo_id","name") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "line_file_sha_idx" ON "line_file" USING btree ("repo_id","line","sha") WHERE "line_file"."sha" is not null;--> statement-breakpoint
-- Every draft as rows, and how many paths it names (its bytes and its files' bytes are as they were counted).
INSERT INTO "line_file" ("repo_id", "line", "path", "sha") SELECT l."repo_id", l."name", e.key, e.value #>> '{}' FROM "line" l, jsonb_each(l."draft") e;--> statement-breakpoint
UPDATE "line" SET "paths" = (SELECT count(*) FROM jsonb_object_keys("draft")) WHERE "draft" <> '{}'::jsonb;--> statement-breakpoint
-- The Worker before, until the new one answers. A draft it writes is laid on the rows, with what it takes, as the new
-- Worker counts it (line_files did this for file_bytes, and the generated column for bytes).
DROP TRIGGER "line_files" ON "line";--> statement-breakpoint
DROP FUNCTION line_files();--> statement-breakpoint
CREATE FUNCTION line_draft_counted() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.bytes := octet_length(NEW.draft::text);
  NEW.paths := (SELECT count(*) FROM jsonb_object_keys(NEW.draft));
  NEW.file_bytes := (SELECT coalesce(sum(b.bytes), 0) FROM blob b
    WHERE b.user_id = NEW.user_id AND b.sha256 IN (SELECT e.value FROM jsonb_each_text(NEW.draft) e));
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER line_draft_counted BEFORE INSERT OR UPDATE OF draft ON line FOR EACH ROW WHEN (NEW.draft IS NOT NULL) EXECUTE FUNCTION line_draft_counted();--> statement-breakpoint
CREATE FUNCTION line_draft_rows() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM line_file f WHERE f.repo_id = NEW.repo_id AND f.line = NEW.name AND NOT (NEW.draft ? f.path);
  INSERT INTO line_file (repo_id, line, path, sha) SELECT NEW.repo_id, NEW.name, e.key, e.value #>> '{}' FROM jsonb_each(NEW.draft) e
    ON CONFLICT (repo_id, line, path) DO UPDATE SET sha = excluded.sha WHERE line_file.sha IS DISTINCT FROM excluded.sha;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER line_draft_rows AFTER INSERT OR UPDATE OF draft ON line FOR EACH ROW WHEN (NEW.draft IS NOT NULL) EXECUTE FUNCTION line_draft_rows();--> statement-breakpoint
-- The new Worker never names draft: a line it makes has none, and one it changes (its version moves, draft as it was)
-- has none from then on. The Worker before reading such a line is answered null, which it takes for no draft: so it may
-- not write one there, and is refused as the database busy (40001: 503, tried again).
CREATE FUNCTION line_draft_stale() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'this draft is kept as rows now' USING ERRCODE = '40001';
END $$;--> statement-breakpoint
CREATE TRIGGER line_draft_stale BEFORE UPDATE OF draft ON line FOR EACH ROW WHEN (OLD.draft IS NULL) EXECUTE FUNCTION line_draft_stale();--> statement-breakpoint
CREATE FUNCTION line_draft_moved() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.draft := NULL;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER line_draft_moved BEFORE UPDATE ON line FOR EACH ROW WHEN (OLD.draft IS NOT NULL AND NEW.version <> OLD.version AND NEW.draft IS NOT DISTINCT FROM OLD.draft) EXECUTE FUNCTION line_draft_moved();--> statement-breakpoint
-- The Worker before's sweep reads the blobs drafts name from draft: one named only by a draft the new Worker changed
-- would seem named by nothing. Such a blob is kept (but not when its account goes: then its lines go too).
CREATE FUNCTION blob_named_by_rows() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user" u WHERE u.id = OLD.user_id)
    AND EXISTS (SELECT 1 FROM line l JOIN line_file f ON f.repo_id = l.repo_id AND f.line = l.name WHERE l.user_id = OLD.user_id AND f.sha = OLD.sha256) THEN
    RETURN NULL;
  END IF;
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER blob_named_by_rows BEFORE DELETE ON blob FOR EACH ROW EXECUTE FUNCTION blob_named_by_rows();
