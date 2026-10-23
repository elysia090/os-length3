-- The tiers one pays for (plan.ts): what each account's subscription is to, go, pro or max, read from its price
-- when Stripe's event came, and the subscription's one item, which a change of tier in Stripe's portal names.
-- Expand only: a row without them (none sold before) reads as the first tier while it is paid.
ALTER TABLE "plan" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "plan" ADD COLUMN "item" text;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_tier" CHECK ((tier is null or tier in ('go', 'pro', 'max')) and (item is null or item ~ '^si_[A-Za-z0-9_]{1,250}$'));