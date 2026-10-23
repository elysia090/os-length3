-- What the Remote spends of R2 and Neon, counted before it is spent (budget.ts): R2's operations of a month,
-- the bytes it holds, an account's uploads of a day. Expand only: a Worker before this one never reads it.
CREATE TABLE "usage" (
	"period" text NOT NULL,
	"kind" text NOT NULL,
	"n" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_period_kind_pk" PRIMARY KEY("period","kind"),
	CONSTRAINT "usage_n" CHECK ("usage"."n" >= 0),
	CONSTRAINT "usage_period" CHECK (char_length(period) <= 10),
	CONSTRAINT "usage_kind" CHECK (char_length(kind) <= 80)
);
--> statement-breakpoint

-- The bytes R2 holds for blobs come and go with their rows, as an account's room does; a release's files are
-- added by the deploy that puts them (mirror.ts). Counted from what there is now, once.
CREATE FUNCTION usage_stored() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO usage (period, kind, n) VALUES ('all', 'r2:stored', NEW.bytes)
      ON CONFLICT (period, kind) DO UPDATE SET n = usage.n + EXCLUDED.n;
  ELSE
    UPDATE usage SET n = greatest(n - OLD.bytes, 0) WHERE period = 'all' AND kind = 'r2:stored';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER blob_stored_in AFTER INSERT ON blob FOR EACH ROW EXECUTE FUNCTION usage_stored();
--> statement-breakpoint
CREATE TRIGGER blob_stored_out AFTER DELETE ON blob FOR EACH ROW EXECUTE FUNCTION usage_stored();
--> statement-breakpoint
INSERT INTO usage (period, kind, n) SELECT 'all', 'r2:stored', coalesce(sum(bytes), 0) FROM blob;
