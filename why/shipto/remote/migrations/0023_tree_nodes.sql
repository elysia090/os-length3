-- A commit's tree as git keeps one (DESIGN.md, "What scales worst", 1): each folder a node named by the digest of its
-- entries (tree_node), kept once in its repo however many commits hold it, and a commit names its root. A line's draft
-- is laid on its head's root (line.base_root), its rows (line_file) only what it changed from it: a path set (`set`),
-- or the root's at a path and under it cut away (`cut`). Work begun on an issue is its head's root and no rows; a
-- commit of the draft is the root with the rows laid on it, made anew only along them, and then the draft is laid on
-- it with none; a merge compares the three roots folder by folder, and lays the draft's rows on what it made. One path
-- of a commit is read by walking its folders (cut_path), and the sweep reads each folder once. Before: a commit took
-- its tree whole (or what it changed from a whole one 16 back), and work begun copied its head's tree as rows.
--
-- What a draft's files take (line.file_bytes) is each file's blob, a blob in two files twice, as a checkout takes them:
-- a root's tree says no more of its blobs than that.
CREATE TABLE "tree_node" (
	"repo_id" bigint NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"entries" jsonb NOT NULL,
	"bytes" integer GENERATED ALWAYS AS (octet_length(entries::text)) STORED NOT NULL,
	CONSTRAINT "tree_node_repo_id_id_pk" PRIMARY KEY("repo_id","id"),
	CONSTRAINT "tree_node_id" CHECK (id ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tree_node_entries" CHECK (jsonb_typeof("tree_node"."entries") = 'object')
);
--> statement-breakpoint
DROP INDEX "line_file_sha_idx";--> statement-breakpoint
ALTER TABLE "cut" ADD COLUMN "root" text;--> statement-breakpoint
ALTER TABLE "cut" ADD COLUMN "paths" integer;--> statement-breakpoint
ALTER TABLE "cut" ADD COLUMN "file_bytes" bigint;--> statement-breakpoint
ALTER TABLE "line" ADD COLUMN "base_root" text;--> statement-breakpoint
ALTER TABLE "line_file" ADD COLUMN "set" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "line_file" ADD COLUMN "cut" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tree_node" ADD CONSTRAINT "tree_node_repo" FOREIGN KEY ("repo_id","user_id") REFERENCES "public"."repo"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tree_node_user_idx" ON "tree_node" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "cut" ADD CONSTRAINT "cut_root" CHECK ("cut"."root" is null or "cut"."root" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "line_file" ADD CONSTRAINT "line_file_says" CHECK ("line_file"."set" or ("line_file"."cut" and "line_file"."sha" is null));--> statement-breakpoint
UPDATE "line" l SET "file_bytes" = (SELECT coalesce(sum(b.bytes), 0) FROM line_file f JOIN blob b ON b.user_id = l.user_id AND b.sha256 = f.sha
  WHERE f.repo_id = l.repo_id AND f.line = l.name);--> statement-breakpoint
-- A tree by its root, whole (each path, a folder named as such null).
CREATE FUNCTION tree_flat(r bigint, root text) RETURNS jsonb LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  WITH RECURSIVE w(prefix, id) AS (
    SELECT ''::text, root
    UNION ALL
    SELECT w.prefix || e.key || '/', e.value ->> 't' FROM w JOIN tree_node n ON n.repo_id = r AND n.id = w.id CROSS JOIN jsonb_each(n.entries) e WHERE e.value ? 't'
  )
  SELECT coalesce(jsonb_object_agg(w.prefix || e.key, coalesce(e.value -> 'f', 'null'::jsonb)), '{}'::jsonb)
  FROM w JOIN tree_node n ON n.repo_id = r AND n.id = w.id CROSS JOIN jsonb_each(n.entries) e WHERE e.value ? 'f' OR e.value ? 'n'
$$;--> statement-breakpoint
-- The entry at a path of a root's tree (a name's {f, t, n}), by its folders from the root; null where there is none.
CREATE FUNCTION tree_entry(r bigint, root text, p text) RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
DECLARE
  at text := root;
  parts text[] := string_to_array(p, '/');
  e jsonb;
BEGIN
  IF root IS NULL OR coalesce(p, '') = '' THEN RETURN NULL; END IF;
  FOR i IN 1 .. cardinality(parts) LOOP
    SELECT n.entries -> parts[i] INTO e FROM tree_node n WHERE n.repo_id = r AND n.id = at;
    IF e IS NULL OR i = cardinality(parts) THEN RETURN e; END IF;
    at := e ->> 't';
    IF at IS NULL THEN RETURN NULL; END IF;
  END LOOP;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION cut_tree(r bigint, c text) RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
DECLARE
  t jsonb;
  x record;
  rt text;
BEGIN
  SELECT k.root INTO rt FROM cut k WHERE k.repo_id = r AND k.id = c;
  IF rt IS NOT NULL THEN RETURN tree_flat(r, rt); END IF;
  FOR x IN WITH RECURSIVE ch(base, tree, gone, n) AS (
      SELECT k.base, k.tree, k.gone, 0 FROM cut k WHERE k.repo_id = r AND k.id = c
      UNION ALL
      SELECT p.base, p.tree, p.gone, ch.n + 1 FROM ch JOIN cut p ON p.repo_id = r AND p.id = ch.base
    ) SELECT ch.base, ch.tree, ch.gone FROM ch ORDER BY ch.n DESC
  LOOP
    t := CASE WHEN x.base IS NULL THEN x.tree ELSE (t - ARRAY(SELECT jsonb_array_elements_text(x.gone))) || x.tree END;
  END LOOP;
  RETURN t;
END $$;--> statement-breakpoint
-- One path of a commit's tree, its blob (null: no file there): by its folders from the root; or, for a commit made
-- before, from the commit back along its bases to the first that says it, never the tree whole made.
CREATE FUNCTION cut_path(r bigint, c text, p text) RETURNS text LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
DECLARE
  rt text;
  x record;
BEGIN
  SELECT k.root INTO rt FROM cut k WHERE k.repo_id = r AND k.id = c;
  IF rt IS NOT NULL THEN RETURN tree_entry(r, rt, p) ->> 'f'; END IF;
  FOR x IN WITH RECURSIVE ch(base, tree, gone, n) AS (
      SELECT k.base, k.tree, k.gone, 0 FROM cut k WHERE k.repo_id = r AND k.id = c
      UNION ALL
      SELECT q.base, q.tree, q.gone, ch.n + 1 FROM ch JOIN cut q ON q.repo_id = r AND q.id = ch.base
    ) SELECT ch.base, ch.tree, ch.gone FROM ch ORDER BY ch.n
  LOOP
    IF x.tree ? p THEN RETURN x.tree ->> p; END IF;
    IF x.base IS NULL OR x.gone ? p THEN RETURN NULL; END IF;
  END LOOP;
  RETURN NULL;
END $$;--> statement-breakpoint
-- A line's draft at a path (its root's tree, its rows laid on it): whether it names the path, and its blob (null: a folder).
CREATE FUNCTION draft_at(r bigint, l text, base text, p text, OUT named boolean, OUT sha text) LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
DECLARE
  x record;
  e jsonb;
  parts text[] := string_to_array(p, '/');
BEGIN
  named := false;
  SELECT f.set, f.sha INTO x FROM line_file f WHERE f.repo_id = r AND f.line = l AND f.path = p;
  IF FOUND THEN
    IF x.set THEN named := true; sha := x.sha; END IF;
    RETURN;
  END IF;
  IF base IS NULL OR EXISTS (SELECT 1 FROM line_file f WHERE f.repo_id = r AND f.line = l AND f.cut
      AND f.path IN (SELECT array_to_string(parts[1:i], '/') FROM generate_series(1, cardinality(parts) - 1) i)) THEN RETURN; END IF;
  e := tree_entry(r, base, p);
  named := e IS NOT NULL AND (e ? 'f' OR e ? 'n');
  sha := e ->> 'f';
END $$;--> statement-breakpoint
-- What a line's draft names at a path and under it: each path, and its blob (null: a folder).
CREATE FUNCTION draft_within(r bigint, l text, base text, p text) RETURNS TABLE(path text, sha text) LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
DECLARE
  e jsonb;
  parts text[] := string_to_array(p, '/');
BEGIN
  RETURN QUERY SELECT f.path::text, f.sha FROM line_file f WHERE f.repo_id = r AND f.line = l AND f.set
    AND (f.path = p OR (f.path >= p || '/' AND f.path < p || '0'));
  IF base IS NULL OR EXISTS (SELECT 1 FROM line_file f WHERE f.repo_id = r AND f.line = l AND f.cut
      AND f.path IN (SELECT array_to_string(parts[1:i], '/') FROM generate_series(1, cardinality(parts)) i)) THEN RETURN; END IF;
  e := tree_entry(r, base, p);
  IF e IS NULL THEN RETURN; END IF;
  IF (e ? 'f' OR e ? 'n') AND NOT EXISTS (SELECT 1 FROM line_file f WHERE f.repo_id = r AND f.line = l AND f.path = p) THEN
    path := p; sha := e ->> 'f'; RETURN NEXT;
  END IF;
  IF e ? 't' THEN
    RETURN QUERY WITH RECURSIVE w(prefix, id) AS (
        SELECT p || '/', e ->> 't'
        UNION ALL
        SELECT w.prefix || x.key || '/', x.value ->> 't' FROM w JOIN tree_node n ON n.repo_id = r AND n.id = w.id CROSS JOIN jsonb_each(n.entries) x
        WHERE x.value ? 't' AND NOT EXISTS (SELECT 1 FROM line_file f WHERE f.repo_id = r AND f.line = l AND f.cut AND f.path = w.prefix || x.key))
      SELECT w.prefix || x.key, x.value ->> 'f' FROM w JOIN tree_node n ON n.repo_id = r AND n.id = w.id CROSS JOIN jsonb_each(n.entries) x
      WHERE (x.value ? 'f' OR x.value ? 'n') AND NOT EXISTS (SELECT 1 FROM line_file f WHERE f.repo_id = r AND f.line = l AND f.path = w.prefix || x.key);
  END IF;
END $$;--> statement-breakpoint
-- A line's draft whole, a path a row: its root's tree, but what its rows cut away or set, and what they set.
CREATE FUNCTION draft_rows(r bigint, l text, base text) RETURNS TABLE(path text, sha text) LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  WITH RECURSIVE mine AS MATERIALIZED (SELECT f.path, f.sha, f.set, f.cut FROM line_file f WHERE f.repo_id = r AND f.line = l),
  -- Each entry of each folder, read once, a folder's entries following it (but where a row cuts it away).
  e(path, value) AS (
    SELECT x.key, x.value FROM tree_node n CROSS JOIN jsonb_each(n.entries) x WHERE base IS NOT NULL AND n.repo_id = r AND n.id = base
    UNION ALL
    SELECT e.path || '/' || x.key, x.value FROM e JOIN tree_node n ON n.repo_id = r AND n.id = e.value ->> 't' CROSS JOIN jsonb_each(n.entries) x
    WHERE NOT EXISTS (SELECT 1 FROM mine WHERE mine.cut AND mine.path = e.path)
  )
  SELECT e.path, e.value ->> 'f' FROM e WHERE (e.value ? 'f' OR e.value ? 'n') AND NOT EXISTS (SELECT 1 FROM mine WHERE mine.path = e.path)
  UNION ALL
  SELECT mine.path, mine.sha FROM mine WHERE mine.set
$$;--> statement-breakpoint
-- The same as one value; and as the JSON text a device is sent, made in one pass (no value built and written out again).
CREATE FUNCTION draft_flat(r bigint, l text, base text) RETURNS jsonb LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_object_agg(d.path, d.sha), '{}'::jsonb) FROM draft_rows(r, l, base) d
$$;--> statement-breakpoint
CREATE FUNCTION draft_text(r bigint, l text, base text) RETURNS text LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT '{' || coalesce(string_agg(to_json(d.path)::text || ':' || coalesce(to_json(d.sha)::text, 'null'), ','), '') || '}' FROM draft_rows(r, l, base) d
$$;--> statement-breakpoint
-- What a commit with a root changed, and what it takes, are said by the Worker that made it (it made only what changed).
CREATE OR REPLACE FUNCTION cut_change() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  was jsonb;
  whole jsonb;
BEGIN
  IF NEW.root IS NOT NULL THEN RETURN NEW; END IF;
  was := coalesce(cut_tree(NEW.repo_id, NEW.parent), '{}'::jsonb);
  whole := CASE WHEN NEW.base IS NULL THEN NEW.tree ELSE (was - ARRAY(SELECT jsonb_array_elements_text(NEW.gone))) || NEW.tree END;
  SELECT t.files, t.folders INTO NEW.files, NEW.folders FROM tree_change(whole, was) t;
  NEW.size := pg_column_size(whole);
  RETURN NEW;
END $$;--> statement-breakpoint
-- The bytes a node takes are its account's, as a commit's were: many made at once, counted at once.
CREATE FUNCTION room_bytes_made() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE room SET used = room.used + g.bytes FROM (SELECT user_id, sum(bytes) AS bytes FROM made GROUP BY user_id) g WHERE room.user_id = g.user_id;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER tree_node_in AFTER INSERT ON tree_node REFERENCING NEW TABLE AS made FOR EACH STATEMENT EXECUTE FUNCTION room_bytes_made();--> statement-breakpoint
CREATE TRIGGER tree_node_out AFTER DELETE ON tree_node REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION room_bytes_gone('unswept');--> statement-breakpoint
-- The Worker before (until 0024) counts what a draft it writes takes as the new one counts it.
CREATE OR REPLACE FUNCTION line_draft_counted() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.bytes := octet_length(NEW.draft::text);
  NEW.paths := (SELECT count(*) FROM jsonb_object_keys(NEW.draft));
  NEW.file_bytes := (SELECT coalesce(sum(b.bytes), 0) FROM jsonb_each_text(NEW.draft) e JOIN blob b ON b.user_id = NEW.user_id AND b.sha256 = e.value);
  RETURN NEW;
END $$;
