-- Billing on the Remote (plan.ts): each account's plan as Stripe last said
-- it, and the webhook events already taken. What an account uses is read
-- from what it holds (its repos, room.used), never counted here.
CREATE TABLE "billing_event" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_event_id" CHECK (id ~ '^evt_[A-Za-z0-9_]{1,250}$'),
	CONSTRAINT "billing_event_type" CHECK (char_length(type) <= 100)
);
--> statement-breakpoint
CREATE TABLE "plan" (
	"user_id" text PRIMARY KEY NOT NULL,
	"customer" text,
	"subscription" text,
	"status" text,
	"period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"event_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_customer_unique" UNIQUE("customer"),
	CONSTRAINT "plan_status" CHECK (status is null or status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
	CONSTRAINT "plan_ids" CHECK ((customer is null or customer ~ '^cus_[A-Za-z0-9_]{1,250}$') and (subscription is null or subscription ~ '^sub_[A-Za-z0-9_]{1,250}$'))
);
--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_event_at_idx" ON "billing_event" USING btree ("at");