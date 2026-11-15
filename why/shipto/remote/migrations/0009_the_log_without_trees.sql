-- What the production-like selftest measured (selftest/prod): the log sent
-- every commit's whole tree (50 commits of a 2,000-file repo: 9 MB from the
-- database and 9 MB to the client, who only counted what each changed);
-- the sweep's recount read the whole cut table for each account it counted;
-- the rail's unread count read every message an account ever had.
--
-- Each commit now says what it changed from its first parent (files, and
-- their folders in path order, as core and the web count them), set by the
-- database as it is made and filled in here for those made before; the log
-- names them and leaves its trees out when asked (repos.ts ?summary=1).
ALTER TABLE "cut" ADD COLUMN "files" integer;--> statement-breakpoint
ALTER TABLE "cut" ADD COLUMN "folders" text[];--> statement-breakpoint
CREATE INDEX "cut_user_idx" ON "cut" USING btree ("user_id","bytes");--> statement-breakpoint
CREATE INDEX "message_unread_idx" ON "message" USING btree ("to_user","from_user") WHERE "message"."read_at" is null;--> statement-breakpoint
CREATE INDEX "review_user_idx" ON "review" USING btree ("user_id","bytes");--> statement-breakpoint
-- What `tree_now` changed from `tree_was` (trees: path -> digest, or null for a folder kept empty): the paths whose
-- digest differs where either has one, counted, and their folders (all but the last part; '' at the top)
-- each once, in the order of their first path, bytewise (core: a BTreeSet; the web: the same here).
CREATE FUNCTION tree_change(tree_now jsonb, tree_was jsonb, OUT files integer, OUT folders text[])
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  WITH changed AS (
    SELECT coalesce(a.key, b.key) COLLATE "C" AS path
    FROM jsonb_each(tree_now) a FULL JOIN jsonb_each(tree_was) b ON a.key = b.key
    WHERE a.value IS DISTINCT FROM b.value AND (jsonb_typeof(a.value) = 'string' OR jsonb_typeof(b.value) = 'string')
  ), folder AS (
    SELECT CASE WHEN strpos(path, '/') > 0 THEN regexp_replace(path, '/[^/]*$', '') ELSE '' END AS name, min(path) AS first FROM changed GROUP BY 1
  )
  SELECT (SELECT count(*)::int FROM changed), coalesce((SELECT array_agg(name ORDER BY first) FROM folder), '{}')
$$;--> statement-breakpoint
CREATE FUNCTION cut_change() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  SELECT t.files, t.folders INTO NEW.files, NEW.folders
  FROM tree_change(NEW.tree, coalesce((SELECT p.tree FROM cut p WHERE p.repo_id = NEW.repo_id AND p.id = NEW.parent), '{}'::jsonb)) t;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER cut_change BEFORE INSERT ON cut FOR EACH ROW EXECUTE FUNCTION cut_change();--> statement-breakpoint
UPDATE cut c SET files = t.files, folders = t.folders
FROM cut s LEFT JOIN cut p ON p.repo_id = s.repo_id AND p.id = s.parent
  CROSS JOIN LATERAL tree_change(s.tree, coalesce(p.tree, '{}'::jsonb)) t
WHERE s.repo_id = c.repo_id AND s.id = c.id;
