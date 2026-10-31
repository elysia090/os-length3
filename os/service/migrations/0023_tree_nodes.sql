-- A commit's tree as git keeps one (DESIGN.md, "What scales worst", 1): each folder a node named by the digest of its
-- entries (tree_node), kept once in its repo however many commits hold it, and a commit names its root. A commit is
-- made of the folders on the paths changed since its parent (line_touched: what a line's saves touched since the
-- commit line.touched_from), each made anew, the rest its parent's; one path of it is read by walking its folders
-- (cut_path), and the sweep reads each folder once, not each commit's tree. A commit took its tree whole before, or
-- what it changed from a whole one at most 16 back, and reading one path, or making the next commit, made it whole.
-- Commits made before stay as they are, read as before.
CREATE TABLE "line_touched" (
	"repo_id" bigint NOT NULL,
	"line" text NOT NULL,
	"path" text COLLATE "C" NOT NULL,
	CONSTRAINT "line_touched_repo_id_line_path_pk" PRIMARY KEY("repo_id","line","path")
);
--> statement-breakpoint
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
ALTER TABLE "cut" ADD COLUMN "root" text;--> statement-breakpoint
ALTER TABLE "line" ADD COLUMN "touched_from" text;--> statement-breakpoint
ALTER TABLE "line_touched" ADD CONSTRAINT "line_touched_line" FOREIGN KEY ("repo_id","line") REFERENCES "public"."line"("repo_id","name") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tree_node" ADD CONSTRAINT "tree_node_repo" FOREIGN KEY ("repo_id","user_id") REFERENCES "public"."repo"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tree_node_user_idx" ON "tree_node" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "cut" ADD CONSTRAINT "cut_root" CHECK ("cut"."root" is null or "cut"."root" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
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
  at text;
  parts text[] := string_to_array(p, '/');
  e jsonb;
  x record;
BEGIN
  SELECT k.root INTO rt FROM cut k WHERE k.repo_id = r AND k.id = c;
  IF rt IS NOT NULL THEN
    at := rt;
    FOR i IN 1 .. coalesce(cardinality(parts), 0) LOOP
      SELECT n.entries -> parts[i] INTO e FROM tree_node n WHERE n.repo_id = r AND n.id = at;
      IF e IS NULL THEN RETURN NULL; END IF;
      IF i = cardinality(parts) THEN RETURN e ->> 'f'; END IF;
      at := e ->> 't';
      IF at IS NULL THEN RETURN NULL; END IF;
    END LOOP;
    RETURN NULL;
  END IF;
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
-- The Worker before (until 0024): a draft it writes changes paths no line_touched names, so the next commit reads it whole.
CREATE OR REPLACE FUNCTION line_draft_counted() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.bytes := octet_length(NEW.draft::text);
  NEW.paths := (SELECT count(*) FROM jsonb_object_keys(NEW.draft));
  NEW.file_bytes := (SELECT coalesce(sum(b.bytes), 0) FROM blob b
    WHERE b.user_id = NEW.user_id AND b.sha256 IN (SELECT e.value FROM jsonb_each_text(NEW.draft) e));
  NEW.touched_from := NULL;
  RETURN NEW;
END $$;
