-- The contract step of 0022, once the new Worker answers: no Worker reads or writes a line's draft as one value any
-- more, so it goes, and what kept the Worker before in step with the rows goes with it (0023 laid drafts on their
-- head's tree, and its Worker never names draft). Each drop may find what it drops gone, and goes on.
DROP TRIGGER IF EXISTS "line_draft_counted" ON "line";--> statement-breakpoint
DROP TRIGGER IF EXISTS "line_draft_rows" ON "line";--> statement-breakpoint
DROP TRIGGER IF EXISTS "line_draft_stale" ON "line";--> statement-breakpoint
DROP TRIGGER IF EXISTS "line_draft_moved" ON "line";--> statement-breakpoint
DROP TRIGGER IF EXISTS "blob_named_by_rows" ON "blob";--> statement-breakpoint
DROP FUNCTION IF EXISTS line_draft_counted();--> statement-breakpoint
DROP FUNCTION IF EXISTS line_draft_rows();--> statement-breakpoint
DROP FUNCTION IF EXISTS line_draft_stale();--> statement-breakpoint
DROP FUNCTION IF EXISTS line_draft_moved();--> statement-breakpoint
DROP FUNCTION IF EXISTS blob_named_by_rows();--> statement-breakpoint
ALTER TABLE "line" DROP COLUMN IF EXISTS "draft";
