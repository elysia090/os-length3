-- What the schema (0000) cannot say in Drizzle: what is kept counted as it
-- changes, and who may do what. Each function names its search_path, so a
-- table of the same name elsewhere is never the one written.

-- Each account has its room from the start (schema.ts room).
CREATE FUNCTION room_made() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO room (user_id) VALUES (NEW.id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER room_made AFTER INSERT ON "user" FOR EACH ROW EXECUTE FUNCTION room_made();
--> statement-breakpoint

-- The bytes a row takes come into its account's room with it and go out
-- with it: blobs, drafts, commits, reviews. With 'unswept', what the
-- account's blobs are named by may have changed (a blob came, a draft
-- changed, a line or commit went), so the sweep looks at its blobs again.
-- Never below nothing: a room that disagreed would otherwise stop a purge.
CREATE FUNCTION room_bytes() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  look boolean := TG_ARGV[0] = 'unswept';
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE room SET used = used + NEW.bytes, unswept = unswept OR look WHERE user_id = NEW.user_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE room SET used = greatest(used - OLD.bytes, 0), unswept = unswept OR look WHERE user_id = OLD.user_id;
  ELSE
    UPDATE room SET used = greatest(used + NEW.bytes - OLD.bytes, 0), unswept = unswept OR look WHERE user_id = NEW.user_id;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER blob_in AFTER INSERT ON blob FOR EACH ROW EXECUTE FUNCTION room_bytes('unswept');
--> statement-breakpoint
CREATE TRIGGER blob_out AFTER DELETE ON blob FOR EACH ROW EXECUTE FUNCTION room_bytes('');
--> statement-breakpoint
CREATE TRIGGER line_in AFTER INSERT ON line FOR EACH ROW EXECUTE FUNCTION room_bytes('');
--> statement-breakpoint
-- A draft changes with its version (app.ts), and its bytes with it.
CREATE TRIGGER line_draft AFTER UPDATE ON line FOR EACH ROW WHEN (OLD.version <> NEW.version OR OLD.bytes <> NEW.bytes) EXECUTE FUNCTION room_bytes('unswept');
--> statement-breakpoint
CREATE TRIGGER line_out AFTER DELETE ON line FOR EACH ROW EXECUTE FUNCTION room_bytes('unswept');
--> statement-breakpoint
CREATE TRIGGER cut_in AFTER INSERT ON cut FOR EACH ROW EXECUTE FUNCTION room_bytes('');
--> statement-breakpoint
CREATE TRIGGER cut_out AFTER DELETE ON cut FOR EACH ROW EXECUTE FUNCTION room_bytes('unswept');
--> statement-breakpoint
CREATE TRIGGER review_in_out AFTER INSERT OR DELETE ON review FOR EACH ROW EXECUTE FUNCTION room_bytes('');
--> statement-breakpoint

-- The stamp GET /v1/moved answers moves whenever GET /v1/repos or
-- /v1/repos/gone would read differently: a repo made, turned off or on, or
-- gone; its main line's draft, head or push; a name remembered as gone.
CREATE FUNCTION room_stamp() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE room SET stamp = stamp + 1 WHERE user_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER repo_stamp AFTER INSERT OR UPDATE OR DELETE ON repo FOR EACH ROW EXECUTE FUNCTION room_stamp();
--> statement-breakpoint
CREATE TRIGGER line_stamp AFTER INSERT OR UPDATE ON line FOR EACH ROW WHEN (NEW.name = 'main') EXECUTE FUNCTION room_stamp();
--> statement-breakpoint
CREATE TRIGGER repo_gone_stamp AFTER INSERT OR UPDATE OR DELETE ON repo_gone FOR EACH ROW EXECUTE FUNCTION room_stamp();
--> statement-breakpoint

-- What a line's draft's files take, each blob once: read when the draft is
-- written, so listing repos reads one number per repo. Every blob a draft
-- names is there when it is written (app.ts refuses one that is missing).
CREATE FUNCTION line_files() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.file_bytes := (SELECT coalesce(sum(b.bytes), 0) FROM blob b
    WHERE b.user_id = NEW.user_id AND b.sha256 IN (SELECT e.value FROM jsonb_each_text(NEW.draft) e));
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER line_files BEFORE INSERT OR UPDATE OF draft ON line FOR EACH ROW EXECUTE FUNCTION line_files();
--> statement-breakpoint

-- Rows written many times a minute leave room in their page, so an update
-- stays beside the row it replaces (a HOT update: no index is touched).
ALTER TABLE room SET (fillfactor = 50);
--> statement-breakpoint
ALTER TABLE line SET (fillfactor = 80);
--> statement-breakpoint

-- Who may do what. The service connects as a login role that is a member of
-- remote_app (made at deploy: README.md, the Remote): it reads and writes
-- rows and nothing else; no table, function or role is made or changed but
-- by migrations, run by the database's owner. Nothing in public is anyone
-- else's to create in.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'remote_app') THEN CREATE ROLE remote_app NOLOGIN; END IF;
END $$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO remote_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO remote_app;
--> statement-breakpoint
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO remote_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO remote_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO remote_app;
