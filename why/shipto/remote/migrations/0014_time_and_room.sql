-- What the sweep deletes by time, found by index (it scanned each table whole, every day, slower as they grew); a
-- passkey's counter as WebAuthn's (unsigned 32-bit); where the sweep's walk through R2's keys left off; and how
-- much of the database is room its rows let go of, so a database at PG_MB takes writes again once deletes made room
-- it reuses (budget.ts full). Expand only.
CREATE TABLE "sweep_mark" (
	"name" text PRIMARY KEY NOT NULL,
	"at" text DEFAULT '' NOT NULL,
	CONSTRAINT "sweep_mark_at" CHECK (char_length(at) <= 1024)
);
--> statement-breakpoint
ALTER TABLE "passkey" ALTER COLUMN "counter" SET DATA TYPE bigint;--> statement-breakpoint
CREATE INDEX "change_merged_idx" ON "change" USING btree ("updated_at") WHERE "change"."state" = 'merged';--> statement-breakpoint
CREATE INDEX "throttle_at_idx" ON "throttle" USING btree ("at");--> statement-breakpoint
CREATE INDEX "deviceCode_expiresAt_idx" ON "device_code" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "session_expiresAt_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "verification_expiresAt_idx" ON "verification" USING btree ("expires_at");--> statement-breakpoint
-- The bytes the database holds that no row does (free and dead space), in its larger tables and their TOAST, by
-- pgstattuple_approx where the extension is there and may be asked (deploy.ts makes it on Neon); 0 where it is not.
-- Its owner's to run (security definer), so the Worker's role is given no statistics of its own.
CREATE OR REPLACE FUNCTION room_free() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	total bigint := 0;
	more bigint;
	r regclass;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgstattuple') THEN RETURN 0; END IF;
	FOR r IN
		SELECT x.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			CROSS JOIN LATERAL (VALUES (c.oid), (NULLIF(c.reltoastrelid, 0))) x(oid)
		WHERE n.nspname = 'public' AND c.relkind = 'r' AND x.oid IS NOT NULL AND pg_relation_size(x.oid) > 8 * 1024 * 1024
	LOOP
		EXECUTE 'SELECT (approx_free_space + dead_tuple_len)::bigint FROM pgstattuple_approx($1)' INTO more USING r;
		total := total + coalesce(more, 0);
	END LOOP;
	RETURN total;
EXCEPTION WHEN OTHERS THEN
	RETURN 0;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION room_free() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION room_free() TO remote_app;
