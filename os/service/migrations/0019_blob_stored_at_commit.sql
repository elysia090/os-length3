-- What R2 holds is counted as a blob comes, in the one row `usage` keeps for it: every account's uploads count
-- there. Counted by a trigger that ran as the blob's row went in, that row was held by each upload until it
-- committed, a round trip or two later, so uploads of every account went one after another. Counted at commit
-- instead (a constraint trigger, deferred), the row is held only while the commit itself is done; the upload
-- asks first whether the bytes it adds fit (budget.ts held), so the count can pass its limit by no more than
-- what is being committed at that moment.
DROP TRIGGER "blob_stored" ON "blob";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "blob_stored" AFTER INSERT ON "blob" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION usage_stored();
