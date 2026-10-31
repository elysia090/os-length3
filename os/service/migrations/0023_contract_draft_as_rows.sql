-- The contract step of 0022, once the new Worker answers: no Worker reads or writes a line's draft as one value any
-- more, so it goes, and what kept the Worker before in step with the rows goes with it.
DROP TRIGGER "line_draft_counted" ON "line";--> statement-breakpoint
DROP TRIGGER "line_draft_rows" ON "line";--> statement-breakpoint
DROP TRIGGER "line_draft_stale" ON "line";--> statement-breakpoint
DROP TRIGGER "line_draft_moved" ON "line";--> statement-breakpoint
DROP TRIGGER "blob_named_by_rows" ON "blob";--> statement-breakpoint
DROP FUNCTION line_draft_counted();--> statement-breakpoint
DROP FUNCTION line_draft_rows();--> statement-breakpoint
DROP FUNCTION line_draft_stale();--> statement-breakpoint
DROP FUNCTION line_draft_moved();--> statement-breakpoint
DROP FUNCTION blob_named_by_rows();--> statement-breakpoint
ALTER TABLE "line" DROP COLUMN "draft";
