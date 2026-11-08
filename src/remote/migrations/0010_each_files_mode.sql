-- A file's mode beside its digest (DESIGN.md §6, "A file's mode"): issue #20 measured a script at 0755
-- come back 0644 from the Remote, on first sync, after an update and after Free, since a tree is path ->
-- digest alone. Each commit and each line's draft now keeps, beside its tree, path -> permission bits for
-- each file with an execute bit; a path not there is a plain file. Expand only: both default to {}, a
-- Worker before this one reads past them, and a client that sends none keeps the modes there were.
ALTER TABLE "cut" ADD COLUMN "modes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "line" ADD COLUMN "modes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cut" ADD CONSTRAINT "cut_modes" CHECK (jsonb_typeof("cut"."modes") = 'object');--> statement-breakpoint
ALTER TABLE "line" ADD CONSTRAINT "line_modes" CHECK (jsonb_typeof("line"."modes") = 'object');