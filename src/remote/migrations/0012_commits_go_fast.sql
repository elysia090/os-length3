-- A repo of many commits went in time quadratic in them (issue: the audit's purge of 16k commits, 26 s): each
-- commit's going read every commit of its repo to check none named it (no index on parent or merged), and
-- each took its bytes out of the room on its own. Now both are found by index, and what goes in one statement
-- leaves the room in one update per account (a statement-level trigger over the rows that went).
CREATE INDEX "cut_parent_idx" ON "cut" USING btree ("repo_id","parent") WHERE "cut"."parent" is not null;--> statement-breakpoint
CREATE INDEX "cut_merged_idx" ON "cut" USING btree ("repo_id","merged") WHERE "cut"."merged" is not null;
--> statement-breakpoint
CREATE FUNCTION room_bytes_gone() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  look boolean := TG_ARGV[0] = 'unswept';
BEGIN
  UPDATE room SET used = greatest(room.used - g.bytes, 0), unswept = room.unswept OR look
    FROM (SELECT user_id, sum(bytes) AS bytes FROM gone GROUP BY user_id) g WHERE room.user_id = g.user_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER cut_out ON cut;
--> statement-breakpoint
CREATE TRIGGER cut_out AFTER DELETE ON cut REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION room_bytes_gone('unswept');
--> statement-breakpoint
DROP TRIGGER line_out ON line;
--> statement-breakpoint
CREATE TRIGGER line_out AFTER DELETE ON line REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION room_bytes_gone('unswept');
--> statement-breakpoint
DROP TRIGGER blob_out ON blob;
--> statement-breakpoint
CREATE TRIGGER blob_out AFTER DELETE ON blob REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION room_bytes_gone('');
