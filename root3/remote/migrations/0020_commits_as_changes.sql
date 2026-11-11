-- A commit took its whole tree, every one: a repo of 500 files, some 50 KB a commit, so the database (450 MB for
-- every account at once) held a few thousand commits' trees at most. A commit is kept as what it changed from its
-- parent now (its base: the paths set, and those gone), and whole only where it has no base: a repo's first, every
-- 16th along a run of changes, and one that changed more than half its files (repos.ts commit). Those made before
-- are whole, as they were. cut_tree() reads one whole, from the last whole one along its bases and the changes after.
ALTER TABLE "cut" ADD COLUMN "base" text;--> statement-breakpoint
ALTER TABLE "cut" ADD COLUMN "gone" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cut" ADD COLUMN "depth" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cut" ADD COLUMN "size" integer;--> statement-breakpoint
ALTER TABLE "cut" ADD CONSTRAINT "cut_gone" CHECK (jsonb_typeof("cut"."gone") = 'array');--> statement-breakpoint
ALTER TABLE "cut" ADD CONSTRAINT "cut_base" CHECK ("cut"."base" is null or "cut"."base" = "cut"."parent");--> statement-breakpoint
-- A commit's tree whole: the last one kept whole along its bases, and each change after it laid on in turn (a base
-- is always its commit's first parent, made before it, and goes only with its repo). Null where there is no such commit.
CREATE FUNCTION cut_tree(r bigint, c text) RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
DECLARE
  t jsonb;
  x record;
BEGIN
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
-- What a commit changed from its parent (0009), now of its tree whole however it is kept; and what that takes whole.
CREATE OR REPLACE FUNCTION cut_change() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  was jsonb := coalesce(cut_tree(NEW.repo_id, NEW.parent), '{}'::jsonb);
  whole jsonb := CASE WHEN NEW.base IS NULL THEN NEW.tree ELSE (was - ARRAY(SELECT jsonb_array_elements_text(NEW.gone))) || NEW.tree END;
BEGIN
  SELECT t.files, t.folders INTO NEW.files, NEW.folders FROM tree_change(whole, was) t;
  NEW.size := pg_column_size(whole);
  RETURN NEW;
END $$;--> statement-breakpoint
UPDATE "cut" SET "size" = pg_column_size("tree") WHERE "size" IS NULL;