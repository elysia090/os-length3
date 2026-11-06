-- What the Remote spends of R2 and Neon, counted before it is spent (budget.ts): R2's operations of a month,
-- the bytes it holds, an account's uploads of a day; and the release files the deploy put in R2 (mirror.ts),
-- which the Remote hands out only once they are here. Expand only: a Worker before this one reads neither.
CREATE TABLE "release_file" (
	"key" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"bytes" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_file_key" CHECK (char_length(key) <= 200),
	CONSTRAINT "release_file_sha" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "release_file_bytes" CHECK ("release_file"."bytes" >= 0)
);
--> statement-breakpoint
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

-- The bytes R2 holds come and go with the rows that name them, blobs and release files alike, as an account's
-- room does. Counted from what there is now, once; the sweep counts it again each day (budget.ts recount).
CREATE FUNCTION usage_stored() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  more bigint := CASE TG_OP WHEN 'INSERT' THEN NEW.bytes WHEN 'DELETE' THEN -OLD.bytes ELSE NEW.bytes - OLD.bytes END;
BEGIN
  INSERT INTO usage (period, kind, n) VALUES ('all', 'r2:stored', greatest(more, 0))
    ON CONFLICT (period, kind) DO UPDATE SET n = greatest(usage.n + more, 0);
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Blobs that go, go many at once (the sweep): taken out together, in one update, not one each.
CREATE FUNCTION usage_stored_gone() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE usage SET n = greatest(n - (SELECT coalesce(sum(bytes), 0) FROM gone), 0) WHERE period = 'all' AND kind = 'r2:stored';
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER blob_stored AFTER INSERT ON blob FOR EACH ROW EXECUTE FUNCTION usage_stored();
--> statement-breakpoint
CREATE TRIGGER blob_stored_gone AFTER DELETE ON blob REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION usage_stored_gone();
--> statement-breakpoint
CREATE TRIGGER release_file_stored AFTER INSERT OR UPDATE OF bytes OR DELETE ON release_file FOR EACH ROW EXECUTE FUNCTION usage_stored();
--> statement-breakpoint
INSERT INTO usage (period, kind, n) SELECT 'all', 'r2:stored', coalesce(sum(bytes), 0) FROM blob;
